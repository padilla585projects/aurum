"""
Entorno de las pruebas del backend privado.

Las variables se fijan *antes* de importar nada de `backend/`, porque tanto la
ruta de la base de datos como el interruptor de ejecución de órdenes se leen en
el momento del import. Con esto la suite nunca toca `backend/aurum.db` ni puede
mandar un mensaje de Telegram de verdad.
"""

from __future__ import annotations

import base64
import os
import pathlib
import sys
import tempfile

BACKEND = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

_TMP = tempfile.mkdtemp(prefix="aurum-tests-")

os.environ.update(
    {
        # Base de datos desechable, distinta de la de desarrollo.
        "AURUM_DB_PATH": os.path.join(_TMP, "aurum-test.db"),
        # Clave de cifrado de prueba: 32 bytes en base64.
        "AURUM_SECRET_KEY": base64.b64encode(b"clave-de-pruebas-de-32-bytes!!!!").decode(),
        # Clave heredada, la que solo sirve para emitir el primer token.
        "AURUM_API_KEY": "clave-heredada-de-prueba",
        "AURUM_OWNER_EMAIL": "owner@aurum.test",
        # Ejecución desactivada por defecto, igual que en producción.
        "AURUM_TRADING_ENABLED": "false",
        "AURUM_MAX_DAILY_EUR": "1000",
        # Integraciones externas neutralizadas: sin esto una prueba podría
        # llegar a llamar a Telegram o a Anthropic de verdad.
        "TELEGRAM_TOKEN": "",
        "TELEGRAM_CHAT_ID": "",
        "ANTHROPIC_API_KEY": "",
        "TR_PHONE": "",
        "TR_PIN": "",
    }
)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import db  # noqa: E402
import main  # noqa: E402
from security import ALL_SCOPES, SCOPE_READ  # noqa: E402

TABLES = (
    "audit_log",
    "order_confirmations",
    "order_log",
    "broker_credentials",
    "api_tokens",
)


@pytest.fixture(autouse=True)
def base_vacia():
    """Cada prueba arranca sin tokens, órdenes ni credenciales."""
    conn = db.connect()
    for table in TABLES:
        conn.execute(f"DELETE FROM {table}")
    conn.commit()
    yield


@pytest.fixture
def client() -> TestClient:
    """
    Cliente sin `with`, a propósito: así no se ejecuta el lifespan y no arrancan
    ni el planificador autónomo ni el bot de Telegram.
    """
    return TestClient(main.app)


@pytest.fixture
def owner():
    """Propietario con todos los ámbitos."""
    token, token_id = db.create_token("owner@aurum.test", role="owner", scopes=list(ALL_SCOPES), label="pruebas")
    return {"token": token, "id": token_id, "email": "owner@aurum.test"}


@pytest.fixture
def usuario():
    """Usuario normal, solo lectura."""
    token, token_id = db.create_token("usuario@aurum.test", role="user", scopes=[SCOPE_READ])
    return {"token": token, "id": token_id, "email": "usuario@aurum.test"}


def auth(token: str) -> dict[str, str]:
    """Cabecera de identificación del backend privado."""
    return {"X-AURUM-KEY": token}
