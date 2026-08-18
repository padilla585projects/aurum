"""
Primitivas de seguridad del backend privado de AURUM.

Cubre dos cosas:

  · Tokens de acceso por usuario. Solo se guarda su SHA-256; el valor en claro
    se muestra una vez, al emitirlo.
  · Cifrado en reposo de las credenciales de broker. Cada usuario guarda su
    teléfono y su PIN de Trade Republic, así que no pueden estar en texto plano
    ni en la base de datos ni en los registros.

El cifrado usa AES-256-GCM con una clave maestra en AURUM_SECRET_KEY. Si esa
variable no está configurada, guardar credenciales falla de forma explícita:
es preferible que la función no esté disponible a que guarde secretos en claro.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from dataclasses import dataclass, field

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# ── Ámbitos ──────────────────────────────────────────────────────────────────

SCOPE_READ = "read"        # consultar cartera, precios, registros propios
SCOPE_EXECUTE = "execute"  # comprar y vender
SCOPE_ADMIN = "admin"      # agentes, control del PC, gestión de tokens

ALL_SCOPES = (SCOPE_READ, SCOPE_EXECUTE, SCOPE_ADMIN)


@dataclass(frozen=True)
class Principal:
    """Quién hace la petición, según el token presentado."""

    user_email: str
    role: str                      # 'owner' | 'user'
    scopes: frozenset[str] = field(default_factory=frozenset)
    token_id: str = ""

    def has(self, scope: str) -> bool:
        return scope in self.scopes

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"


# ── Tokens ───────────────────────────────────────────────────────────────────

def new_token() -> str:
    """Token opaco de 32 bytes. Se muestra una sola vez."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """SHA-256 en hex. La entrada ya es aleatoria, así que no lleva sal."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def tokens_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)


# ── Cifrado de credenciales ──────────────────────────────────────────────────

class SecretsNotConfigured(RuntimeError):
    """AURUM_SECRET_KEY no está disponible o no es válida."""


def _master_key() -> bytes:
    raw = os.getenv("AURUM_SECRET_KEY", "").strip()
    if not raw:
        raise SecretsNotConfigured(
            "AURUM_SECRET_KEY no está configurada: no se pueden guardar "
            "credenciales de broker cifradas. Genera una con "
            'python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"'
        )
    try:
        key = base64.b64decode(raw)
    except Exception as exc:  # noqa: BLE001 - el motivo exacto no aporta nada aquí
        raise SecretsNotConfigured("AURUM_SECRET_KEY no es base64 válido.") from exc
    if len(key) != 32:
        raise SecretsNotConfigured("AURUM_SECRET_KEY debe codificar exactamente 32 bytes.")
    return key


def secrets_available() -> bool:
    """True si el cifrado está listo para usarse."""
    try:
        _master_key()
        return True
    except SecretsNotConfigured:
        return False


def encrypt(plaintext: str, associated: str = "") -> str:
    """
    Cifra con AES-256-GCM. Devuelve base64 de nonce||ciphertext.

    `associated` se autentica pero no se cifra: se usa para atar el criptograma
    a su dueño, de forma que el registro de otro usuario no pueda reutilizarse.
    """
    nonce = os.urandom(12)
    aead = AESGCM(_master_key())
    blob = aead.encrypt(nonce, plaintext.encode("utf-8"), associated.encode("utf-8"))
    return base64.b64encode(nonce + blob).decode("ascii")


def decrypt(payload: str, associated: str = "") -> str:
    raw = base64.b64decode(payload)
    nonce, blob = raw[:12], raw[12:]
    aead = AESGCM(_master_key())
    return aead.decrypt(nonce, blob, associated.encode("utf-8")).decode("utf-8")


# ── Ayudas de registro ───────────────────────────────────────────────────────

def redact(value: str, keep: int = 2) -> str:
    """Versión truncada de un secreto, para poder registrarlo sin filtrarlo."""
    if not value:
        return ""
    if len(value) <= keep:
        return "*" * len(value)
    return value[:keep] + "*" * (len(value) - keep)
