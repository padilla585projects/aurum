"""
Almacenamiento persistente del backend privado (SQLite).

Antes, todo el estado del backend vivía en memoria: tokens, credenciales,
cola del agente y registros. Se perdía en cada reinicio y no había forma de
auditar qué se había ejecutado. Este módulo cubre lo que no puede permitirse
ser volátil:

  · tokens de acceso por usuario, con rol y ámbitos
  · credenciales de broker por usuario, cifradas
  · registro de órdenes, con clave de idempotencia y límite diario
  · auditoría

Se usa sqlite3 con un único hilo de escritura protegido por un lock: el
backend es de uso personal y el volumen no justifica nada más complejo.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

from security import (
    ALL_SCOPES,
    SCOPE_ADMIN,
    SCOPE_EXECUTE,
    SCOPE_READ,
    Principal,
    encrypt,
    decrypt,
    hash_token,
    new_token,
)

DB_PATH = os.getenv("AURUM_DB_PATH", os.path.join(os.path.dirname(__file__), "aurum.db"))

_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS api_tokens (
    id           TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    user_email   TEXT NOT NULL,
    label        TEXT,
    role         TEXT NOT NULL DEFAULT 'user',
    scopes       TEXT NOT NULL,
    created_at   REAL NOT NULL,
    expires_at   REAL,
    revoked_at   REAL,
    last_used_at REAL
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_email);

CREATE TABLE IF NOT EXISTS broker_credentials (
    user_email  TEXT PRIMARY KEY,
    broker      TEXT NOT NULL DEFAULT 'trade_republic',
    phone_enc   TEXT NOT NULL,
    pin_enc     TEXT NOT NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS order_log (
    id               TEXT PRIMARY KEY,
    idempotency_key  TEXT NOT NULL,
    user_email       TEXT NOT NULL,
    side             TEXT NOT NULL,          -- 'buy' | 'sell'
    ticker           TEXT,
    isin             TEXT NOT NULL,
    amount_eur       REAL NOT NULL,
    shares           REAL,
    status           TEXT NOT NULL,          -- 'executed' | 'error' | 'pending_confirmation'
    broker_order_id  TEXT,
    error            TEXT,
    created_at       REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem ON order_log(user_email, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_orders_user_ts ON order_log(user_email, created_at);

CREATE TABLE IF NOT EXISTS order_confirmations (
    token        TEXT PRIMARY KEY,
    user_email   TEXT NOT NULL,
    payload      TEXT NOT NULL,
    created_at   REAL NOT NULL,
    expires_at   REAL NOT NULL,
    consumed_at  REAL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         REAL NOT NULL,
    user_email TEXT,
    event      TEXT NOT NULL,
    detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
"""


def connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(SCHEMA)
        _conn.commit()
    return _conn


def _execute(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    conn = connect()
    with _lock:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur


def _query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    conn = connect()
    with _lock:
        return conn.execute(sql, params).fetchall()


# ── Auditoría ────────────────────────────────────────────────────────────────

def audit(event: str, user_email: Optional[str] = None, detail: Any = None) -> None:
    try:
        _execute(
            "INSERT INTO audit_log (ts, user_email, event, detail) VALUES (?, ?, ?, ?)",
            (time.time(), user_email, event, json.dumps(detail)[:2000] if detail is not None else None),
        )
    except Exception:
        # La auditoría nunca debe tumbar la petición que la origina.
        pass


def recent_audit(limit: int = 100) -> list[dict]:
    rows = _query("SELECT ts, user_email, event, detail FROM audit_log ORDER BY ts DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]


# ── Tokens ───────────────────────────────────────────────────────────────────

def count_tokens() -> int:
    return _query("SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL")[0]["n"]


def create_token(
    user_email: str,
    role: str = "user",
    scopes: Optional[list[str]] = None,
    label: str = "",
    ttl_days: Optional[int] = None,
) -> tuple[str, str]:
    """
    Crea un token y devuelve (token_en_claro, id). El valor en claro no vuelve
    a estar disponible: la tabla solo guarda su hash.
    """
    granted = [s for s in (scopes or [SCOPE_READ]) if s in ALL_SCOPES]
    if not granted:
        granted = [SCOPE_READ]

    token = new_token()
    token_id = hash_token(token)[:16]
    now = time.time()
    _execute(
        """INSERT INTO api_tokens (id, token_hash, user_email, label, role, scopes, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            token_id,
            hash_token(token),
            user_email.strip().lower(),
            label or None,
            role,
            ",".join(granted),
            now,
            now + ttl_days * 86400 if ttl_days else None,
        ),
    )
    audit("token_created", user_email, {"role": role, "scopes": granted, "label": label})
    return token, token_id


def authenticate(token: str) -> Optional[Principal]:
    """Devuelve el principal del token, o None si no vale."""
    if not token:
        return None
    rows = _query(
        """SELECT id, user_email, role, scopes, expires_at, revoked_at
             FROM api_tokens WHERE token_hash = ?""",
        (hash_token(token),),
    )
    if not rows:
        return None
    row = rows[0]
    now = time.time()
    if row["revoked_at"] is not None:
        return None
    if row["expires_at"] is not None and row["expires_at"] < now:
        return None

    _execute("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", (now, row["id"]))
    return Principal(
        user_email=row["user_email"],
        role=row["role"],
        scopes=frozenset(s for s in row["scopes"].split(",") if s),
        token_id=row["id"],
    )


def revoke_token(token_id: str, by_email: str) -> bool:
    cur = _execute(
        "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        (time.time(), token_id),
    )
    if cur.rowcount:
        audit("token_revoked", by_email, {"token_id": token_id})
    return cur.rowcount > 0


def list_tokens() -> list[dict]:
    rows = _query(
        """SELECT id, user_email, label, role, scopes, created_at, expires_at, revoked_at, last_used_at
             FROM api_tokens ORDER BY created_at DESC"""
    )
    return [dict(r) for r in rows]


# ── Credenciales de broker ───────────────────────────────────────────────────

@dataclass
class BrokerCredentials:
    user_email: str
    phone: str
    pin: str


def set_broker_credentials(user_email: str, phone: str, pin: str, broker: str = "trade_republic") -> None:
    """Guarda las credenciales cifradas, atadas al correo del usuario."""
    email = user_email.strip().lower()
    now = time.time()
    _execute(
        """INSERT INTO broker_credentials (user_email, broker, phone_enc, pin_enc, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_email) DO UPDATE SET
             broker = excluded.broker,
             phone_enc = excluded.phone_enc,
             pin_enc = excluded.pin_enc,
             updated_at = excluded.updated_at""",
        (email, broker, encrypt(phone, email), encrypt(pin, email), now, now),
    )
    audit("broker_credentials_set", email, {"broker": broker})


def get_broker_credentials(user_email: str) -> Optional[BrokerCredentials]:
    email = user_email.strip().lower()
    rows = _query("SELECT phone_enc, pin_enc FROM broker_credentials WHERE user_email = ?", (email,))
    if not rows:
        return None
    return BrokerCredentials(
        user_email=email,
        phone=decrypt(rows[0]["phone_enc"], email),
        pin=decrypt(rows[0]["pin_enc"], email),
    )


def has_broker_credentials(user_email: str) -> bool:
    return bool(_query("SELECT 1 FROM broker_credentials WHERE user_email = ?", (user_email.strip().lower(),)))


def delete_broker_credentials(user_email: str) -> None:
    email = user_email.strip().lower()
    _execute("DELETE FROM broker_credentials WHERE user_email = ?", (email,))
    audit("broker_credentials_deleted", email)


# ── Órdenes ──────────────────────────────────────────────────────────────────

def find_order(user_email: str, idempotency_key: str) -> Optional[dict]:
    """Orden ya registrada con esa clave, si existe."""
    rows = _query(
        "SELECT * FROM order_log WHERE user_email = ? AND idempotency_key = ?",
        (user_email.strip().lower(), idempotency_key),
    )
    return dict(rows[0]) if rows else None


def record_order(
    order_id: str,
    idempotency_key: str,
    user_email: str,
    side: str,
    isin: str,
    amount_eur: float,
    status: str,
    ticker: Optional[str] = None,
    shares: Optional[float] = None,
    broker_order_id: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    _execute(
        """INSERT OR REPLACE INTO order_log
             (id, idempotency_key, user_email, side, ticker, isin, amount_eur, shares,
              status, broker_order_id, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            order_id,
            idempotency_key,
            user_email.strip().lower(),
            side,
            ticker,
            isin,
            amount_eur,
            shares,
            status,
            broker_order_id,
            error,
            time.time(),
        ),
    )


def executed_today_eur(user_email: str) -> float:
    """Importe ejecutado en las últimas 24 h, para el límite diario."""
    since = time.time() - 86400
    rows = _query(
        """SELECT COALESCE(SUM(amount_eur), 0) AS total FROM order_log
            WHERE user_email = ? AND status = 'executed' AND created_at >= ?""",
        (user_email.strip().lower(), since),
    )
    return float(rows[0]["total"])


def recent_orders(user_email: str, limit: int = 50) -> list[dict]:
    rows = _query(
        "SELECT * FROM order_log WHERE user_email = ? ORDER BY created_at DESC LIMIT ?",
        (user_email.strip().lower(), limit),
    )
    return [dict(r) for r in rows]


# ── Doble confirmación ───────────────────────────────────────────────────────

CONFIRMATION_TTL_SECONDS = 10 * 60


def create_confirmation(user_email: str, payload: dict) -> str:
    """
    Registra una operación pendiente y devuelve el token que hay que presentar
    para ejecutarla. El plan queda congelado: en el segundo paso no se puede
    cambiar el importe ni el valor.
    """
    token = new_token()
    now = time.time()
    _execute(
        """INSERT INTO order_confirmations (token, user_email, payload, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)""",
        (hash_token(token), user_email.strip().lower(), json.dumps(payload), now, now + CONFIRMATION_TTL_SECONDS),
    )
    return token


def consume_confirmation(user_email: str, token: str) -> Optional[dict]:
    """Valida y consume el token. Devuelve el plan original, o None si no vale."""
    email = user_email.strip().lower()
    token_hash = hash_token(token)
    rows = _query(
        "SELECT payload, expires_at, consumed_at FROM order_confirmations WHERE token = ? AND user_email = ?",
        (token_hash, email),
    )
    if not rows:
        return None
    row = rows[0]
    if row["consumed_at"] is not None or row["expires_at"] < time.time():
        return None
    cur = _execute(
        "UPDATE order_confirmations SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL",
        (time.time(), token_hash),
    )
    if not cur.rowcount:
        return None  # otra petición lo consumió a la vez
    return json.loads(row["payload"])
