"""
Sesiones de broker por usuario.

Cada usuario tiene sus propias credenciales de Trade Republic (cifradas en
db.broker_credentials) y, por tanto, su propia sesión WebSocket. Este módulo es
el registro que las mantiene separadas.

Trade Republic exige un OTP al iniciar sesión, así que el alta es en dos pasos y
no puede automatizarse del todo: `begin_login` envía el código al teléfono del
usuario y `complete_login` lo verifica. A partir de ahí la sesión se reutiliza
mientras el proceso siga vivo.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Optional

import db
from tr_client import TRAuthError, TRClient

logger = logging.getLogger(__name__)


@dataclass
class BrokerSession:
    user_email: str
    client: TRClient
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def authenticated(self) -> bool:
        return self.client.authenticated


_sessions: dict[str, BrokerSession] = {}
_registry_lock = asyncio.Lock()


async def _session_for(user_email: str) -> BrokerSession:
    email = user_email.strip().lower()
    async with _registry_lock:
        session = _sessions.get(email)
        if session is None:
            session = BrokerSession(user_email=email, client=TRClient())
            _sessions[email] = session
        return session


def adopt(user_email: str, client: TRClient) -> None:
    """
    Registra un cliente ya existente como sesión de un usuario.

    Lo usa el arranque del backend para que la sesión del propietario —la que
    alimenta el ciclo autónomo con las credenciales del .env— sea la misma que
    ve ese usuario desde la API.
    """
    _sessions[user_email.strip().lower()] = BrokerSession(user_email=user_email.strip().lower(), client=client)


async def get_session(user_email: str) -> BrokerSession:
    return await _session_for(user_email)


async def is_authenticated(user_email: str) -> bool:
    session = await _session_for(user_email)
    return session.authenticated


async def begin_login(user_email: str) -> dict:
    """
    Primer paso del acceso al broker. Devuelve qué segundo factor toca.

    Las credenciales se leen descifradas solo aquí y no se registran. Ya no
    devuelve un processId a secas: desde que TR retiró el SMS, quien llama
    necesita saber si toca esperar una aprobación en el móvil o pedir un
    código, porque son dos pantallas distintas.
    """
    creds = db.get_broker_credentials(user_email)
    if creds is None:
        raise TRAuthError("No hay credenciales de broker guardadas para esta cuenta.")

    session = await _session_for(user_email)
    async with session.lock:
        inicio = await session.client.login_init(creds.phone, creds.pin)
    db.audit("broker_login_started", user_email)
    return inicio


async def complete_login(user_email: str, otp: str = "") -> None:
    """Segundo paso: completa el acceso y deja la sesión lista para operar.

    Sin código significa que se espera a la aprobación desde la aplicación de
    Trade Republic, que es el camino habitual ahora.
    """
    session = await _session_for(user_email)
    async with session.lock:
        await session.client.login_verify(otp)
        await session.client.connect()
    db.audit("broker_login_completed", user_email)


async def require_authenticated(user_email: str) -> BrokerSession:
    """
    Devuelve la sesión lista para usar, o falla si el usuario no ha completado
    el acceso al broker.
    """
    session = await _session_for(user_email)
    if not session.authenticated:
        raise TRAuthError("No has iniciado sesión en Trade Republic con esta cuenta.")
    async with session.lock:
        await session.client.ensure_connected()
    return session


async def disconnect(user_email: str) -> None:
    session = _sessions.get(user_email.strip().lower())
    if session:
        await session.client.disconnect()


async def disconnect_all() -> None:
    for session in list(_sessions.values()):
        try:
            await session.client.disconnect()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Error cerrando sesión de %s: %s", session.user_email, exc)


def active_users() -> list[str]:
    return [email for email, s in _sessions.items() if s.authenticated]
