"""
Endpoints de identidad, credenciales de broker y doble confirmación.

Van en un módulo aparte para no seguir engordando main.py, que ya pasa de las
mil líneas. Se registran con `register(app, deps)` desde main.py, que le pasa
las dependencias que necesita en lugar de importarlas al revés y crear un ciclo.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from fastapi import FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

import broker_sessions
import db
from security import ALL_SCOPES, SCOPE_ADMIN, SCOPE_READ, Principal, secrets_available
from tr_client import TRAuthError

logger = logging.getLogger(__name__)


class BrokerCredentialsBody(BaseModel):
    phone: str = Field(min_length=6, max_length=24)
    pin: str = Field(min_length=4, max_length=12)


class BrokerOtpBody(BaseModel):
    otp: str = Field(min_length=3, max_length=10)


class TokenBody(BaseModel):
    user_email: str = Field(min_length=3, max_length=254)
    role: str = Field(default="user")
    scopes: list[str] = Field(default_factory=lambda: [SCOPE_READ])
    label: str = Field(default="", max_length=80)
    ttl_days: Optional[int] = Field(default=None, ge=1, le=3650)


class PrepareOrderBody(BaseModel):
    side: str = Field(pattern="^(buy|sell)$")
    trades: list[dict]


def register(
    app: FastAPI,
    *,
    require_key: Callable[..., Principal],
    require_scope: Callable[[Principal, str], None],
    bootstrap_key_valid: Callable[[str], bool],
    order_plan: Callable[[str, list], dict],
    owner_email: str,
    trading_enabled: bool,
    max_daily_eur: float,
) -> None:
    """Añade a `app` las rutas de identidad y broker."""

    # ── Identidad ────────────────────────────────────────────────────────────

    @app.get("/me")
    async def whoami(x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        """Quién soy según mi token, y qué puedo hacer con él."""
        principal = require_key(x_aurum_key)
        return {
            "user_email": principal.user_email,
            "role": principal.role,
            "scopes": sorted(principal.scopes),
            "broker_linked": db.has_broker_credentials(principal.user_email),
            "broker_session_saved": db.has_broker_session(principal.user_email),
            "broker_authenticated": await broker_sessions.is_authenticated(principal.user_email),
            "trading_enabled": trading_enabled,
            "max_daily_eur": max_daily_eur,
            "executed_today_eur": db.executed_today_eur(principal.user_email),
        }

    @app.post("/admin/tokens")
    async def create_token(body: TokenBody, x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        """
        Emite un token de acceso. Solo el propietario puede hacerlo.

        Excepción de arranque: si todavía no existe ningún token, se acepta la
        antigua AURUM_API_KEY para crear el primero. En cuanto hay uno emitido,
        esa vía deja de funcionar.
        """
        bootstrapping = bootstrap_key_valid(x_aurum_key)
        if bootstrapping:
            if body.role != "owner":
                raise HTTPException(400, "El primer token debe ser de rol 'owner'.")
            issuer = "bootstrap"
        else:
            principal = require_key(x_aurum_key)
            require_scope(principal, SCOPE_ADMIN)
            if not principal.is_owner:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo el propietario emite tokens.")
            issuer = principal.user_email

        invalid = [s for s in body.scopes if s not in ALL_SCOPES]
        if invalid:
            raise HTTPException(400, f"Ámbitos desconocidos: {', '.join(invalid)}")

        token, token_id = db.create_token(
            user_email=body.user_email,
            role=body.role,
            scopes=body.scopes,
            label=body.label,
            ttl_days=body.ttl_days,
        )
        db.audit("token_issued", issuer, {"for": body.user_email, "scopes": body.scopes})
        # El valor en claro solo se devuelve aquí; después ya no es recuperable.
        return {"token": token, "id": token_id, "user_email": body.user_email, "scopes": body.scopes}

    @app.get("/admin/tokens")
    async def list_tokens(x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        principal = require_key(x_aurum_key)
        require_scope(principal, SCOPE_ADMIN)
        if not principal.is_owner:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo el propietario ve los tokens.")
        return {"tokens": db.list_tokens()}

    @app.delete("/admin/tokens/{token_id}")
    async def revoke_token(token_id: str, x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        principal = require_key(x_aurum_key)
        require_scope(principal, SCOPE_ADMIN)
        if not principal.is_owner:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo el propietario revoca tokens.")
        return {"revoked": db.revoke_token(token_id, principal.user_email)}

    @app.get("/admin/audit")
    async def read_audit(limit: int = 100, x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        principal = require_key(x_aurum_key)
        require_scope(principal, SCOPE_ADMIN)
        if not principal.is_owner:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo el propietario consulta la auditoría.")
        return {"entries": db.recent_audit(min(limit, 500))}

    # ── Credenciales de broker por usuario ───────────────────────────────────

    @app.put("/broker/credentials")
    async def set_credentials(body: BrokerCredentialsBody, x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        """
        Guarda las credenciales de Trade Republic del usuario, cifradas.

        El PIN no se registra en ningún log ni se devuelve nunca. Si el cifrado
        no está configurado, la operación falla en vez de guardarlo en claro.
        """
        principal = require_key(x_aurum_key)
        require_scope(principal, SCOPE_READ)
        if not secrets_available():
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "AURUM_SECRET_KEY no está configurada: no se pueden guardar credenciales cifradas.",
            )
        db.set_broker_credentials(principal.user_email, body.phone, body.pin)
        return {"stored": True, "user_email": principal.user_email}

    @app.get("/broker/credentials")
    async def credentials_status(x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        principal = require_key(x_aurum_key)
        require_scope(principal, SCOPE_READ)
        return {
            "linked": db.has_broker_credentials(principal.user_email),
            "authenticated": await broker_sessions.is_authenticated(principal.user_email),
        }

    @app.delete("/broker/credentials")
    async def delete_credentials(x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        principal = require_key(x_aurum_key)
        require_scope(principal, SCOPE_READ)
        await broker_sessions.disconnect(principal.user_email)
        db.delete_broker_credentials(principal.user_email)
        return {"deleted": True}

    @app.post("/broker/login")
    async def broker_login(x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        """Paso 1: Trade Republic envía un OTP al teléfono del usuario."""
        principal = require_key(x_aurum_key)
        require_scope(principal, SCOPE_READ)
        try:
            process_id = await broker_sessions.begin_login(principal.user_email)
        except TRAuthError as e:
            raise HTTPException(400, str(e))
        return {"processId": process_id, "otpRequired": True}

    @app.post("/broker/login/verify")
    async def broker_login_verify(body: BrokerOtpBody, x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        """Paso 2: verifica el OTP y deja la sesión de broker lista."""
        principal = require_key(x_aurum_key)
        require_scope(principal, SCOPE_READ)
        try:
            await broker_sessions.complete_login(principal.user_email, body.otp)
        except TRAuthError as e:
            raise HTTPException(400, str(e))
        return {"status": "authenticated"}

    # ── Doble confirmación y registro de órdenes ─────────────────────────────

    @app.post("/orders/prepare")
    async def prepare_order(body: PrepareOrderBody, x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        """
        Paso 1 de cualquier operación: congela el plan y devuelve el token que
        habrá que presentar para ejecutarlo. El token caduca en 10 minutos, vale
        para un solo uso y no admite cambios en el plan.
        """
        principal = require_key(x_aurum_key)
        require_scope(principal, SCOPE_READ)
        if not body.trades:
            raise HTTPException(400, "Lista de trades vacía")

        plan = order_plan(body.side, body.trades)
        token = db.create_confirmation(principal.user_email, plan)
        total = sum(item["amount"] for item in plan["items"])
        db.audit("order_prepared", principal.user_email, {"side": body.side, "total": total})

        return {
            "confirmation_token": token,
            "plan": plan,
            "total_eur": total,
            "expires_in_seconds": db.CONFIRMATION_TTL_SECONDS,
            "trading_enabled": trading_enabled,
        }

    @app.get("/orders")
    async def list_orders(limit: int = 50, x_aurum_key: str = Header(default="")) -> dict[str, Any]:
        """Historial persistente de órdenes del usuario."""
        principal = require_key(x_aurum_key)
        require_scope(principal, SCOPE_READ)
        return {
            "orders": db.recent_orders(principal.user_email, min(limit, 200)),
            "executed_today_eur": db.executed_today_eur(principal.user_email),
            "max_daily_eur": max_daily_eur,
        }
