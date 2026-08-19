"""
Primitivas de seguridad del backend.

La propiedad que más importa aquí es que el cifrado esté atado al dueño: el
criptograma de las credenciales de una persona no debe poder descifrarse con el
correo de otra, aunque la clave maestra sea la misma para todos.
"""

from __future__ import annotations

import base64
import os

import pytest
from cryptography.exceptions import InvalidTag

import security
from security import (
    ALL_SCOPES,
    SCOPE_ADMIN,
    SCOPE_EXECUTE,
    SCOPE_READ,
    Principal,
    SecretsNotConfigured,
    decrypt,
    encrypt,
    hash_token,
    new_token,
    redact,
    secrets_available,
    tokens_equal,
)


class TestTokens:
    def test_cada_token_es_distinto_y_largo(self):
        tokens = {new_token() for _ in range(50)}
        assert len(tokens) == 50
        assert all(len(t) >= 40 for t in tokens)

    def test_el_hash_es_determinista_y_no_reversible_a_simple_vista(self):
        token = new_token()
        assert hash_token(token) == hash_token(token)
        assert len(hash_token(token)) == 64
        assert token not in hash_token(token)

    def test_comparacion_en_tiempo_constante(self):
        assert tokens_equal("abc", "abc")
        assert not tokens_equal("abc", "abd")
        assert not tokens_equal("abc", "abcd")


class TestCifrado:
    def test_ida_y_vuelta(self):
        assert decrypt(encrypt("mi-pin", "ana@aurum.test"), "ana@aurum.test") == "mi-pin"

    def test_el_mismo_texto_produce_criptogramas_distintos(self):
        # Nonce aleatorio: dos usuarios con el mismo PIN no son distinguibles.
        assert encrypt("1234", "ana@aurum.test") != encrypt("1234", "ana@aurum.test")

    def test_el_criptograma_de_una_persona_no_se_abre_con_el_correo_de_otra(self):
        blob = encrypt("mi-pin", "ana@aurum.test")
        with pytest.raises(InvalidTag):
            decrypt(blob, "bruno@aurum.test")

    def test_un_criptograma_manipulado_se_rechaza(self):
        blob = bytearray(base64.b64decode(encrypt("mi-pin", "ana@aurum.test")))
        blob[-1] ^= 0x01
        with pytest.raises(InvalidTag):
            decrypt(base64.b64encode(bytes(blob)).decode(), "ana@aurum.test")

    def test_sin_clave_maestra_falla_en_vez_de_guardar_en_claro(self, monkeypatch):
        monkeypatch.setenv("AURUM_SECRET_KEY", "")
        assert secrets_available() is False
        with pytest.raises(SecretsNotConfigured):
            encrypt("mi-pin", "ana@aurum.test")

    def test_rechaza_una_clave_maestra_con_formato_o_longitud_incorrectos(self, monkeypatch):
        monkeypatch.setenv("AURUM_SECRET_KEY", "esto no es base64 !!")
        with pytest.raises(SecretsNotConfigured):
            encrypt("x", "")

        monkeypatch.setenv("AURUM_SECRET_KEY", base64.b64encode(b"corta").decode())
        with pytest.raises(SecretsNotConfigured):
            encrypt("x", "")

    def test_con_la_clave_del_entorno_de_pruebas_esta_disponible(self):
        assert secrets_available() is True
        assert os.getenv("AURUM_SECRET_KEY")


class TestPrincipal:
    def test_ambitos_y_rol(self):
        principal = Principal(
            user_email="ana@aurum.test",
            role="owner",
            scopes=frozenset({SCOPE_READ, SCOPE_EXECUTE}),
            token_id="abc",
        )
        assert principal.has(SCOPE_READ)
        assert principal.has(SCOPE_EXECUTE)
        assert not principal.has(SCOPE_ADMIN)
        assert principal.is_owner

        normal = Principal(user_email="b@aurum.test", role="user", scopes=frozenset({SCOPE_READ}))
        assert not normal.is_owner

    def test_la_lista_de_ambitos_no_ha_cambiado_sin_querer(self):
        # Si aquí falla algo, es que se ha añadido o quitado un permiso: hay que
        # revisar quién lo concede antes de tocar la prueba.
        assert set(ALL_SCOPES) == {"read", "execute", "admin"}


class TestRedact:
    def test_deja_ver_lo_justo_para_identificar_un_secreto(self):
        assert redact("1234567890") == "12********"
        assert redact("1234567890", keep=4) == "1234******"
        assert redact("ab") == "**"
        assert redact("") == ""

    def test_el_modulo_no_expone_la_clave_maestra(self):
        assert not hasattr(security, "MASTER_KEY")
