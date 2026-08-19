#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  AURUM — instalador del backend privado (Linux y macOS)
#
#  Deja el backend funcionando y te da las dos cosas que hay que pegar
#  en Ajustes: la dirección y tu token.
#
#  Uso:  bash instalar.sh
# ═══════════════════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")"

azul()   { printf '\n\033[36m[%s] %s\033[0m\n' "$1" "$2"; }
bien()   { printf '    \033[32mOK\033[0m  %s\n' "$1"; }
aviso()  { printf '    \033[33m!\033[0m   %s\n' "$1"; }
muere()  { printf '\n    \033[31mX\033[0m   %s\n\n' "$1"; exit 1; }

printf '\n  AURUM - backend privado\n  ------------------------\n'

# ── 1. Python ──────────────────────────────────────────────────
azul 1 "Comprobando Python"
command -v python3 >/dev/null 2>&1 || muere "No hay python3. Instálalo con el gestor de paquetes de tu sistema."
version=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' \
  || muere "Python $version es demasiado antiguo. Hace falta 3.10 o superior."
bien "Python $version"

# ── 2. Entorno aislado ─────────────────────────────────────────
# Se usa un entorno propio para no mezclar estas dependencias con las del
# sistema, que es de donde salen la mitad de los problemas.
azul 2 "Preparando el entorno"
[ -d .venv ] || python3 -m venv .venv
py="$PWD/.venv/bin/python"
[ -x "$py" ] || muere "No se ha podido crear el entorno virtual."
bien "Entorno listo"

azul 3 "Instalando dependencias (puede tardar un par de minutos)"
"$py" -m pip install --quiet --upgrade pip
"$py" -m pip install --quiet -r requirements.txt || muere "Fallo instalando dependencias."
bien "Dependencias instaladas"

# ── 4. Configuración ───────────────────────────────────────────
azul 4 "Configuración"
if [ -f .env ]; then
  bien "Ya existe un .env, se conserva"
else
  clave_arranque=$("$py" -c 'import secrets; print(secrets.token_hex(32))')
  clave_cifrado=$("$py" -c 'import os,base64; print(base64.b64encode(os.urandom(32)).decode())')
  # Se admite como argumento para poder ejecutarlo sin intervencion.
  correo="${1:-}"
  if [ -z "$correo" ]; then
    printf '    Tu correo (el mismo con el que entras en AURUM): '
    read -r correo
  fi
  [ -n "$correo" ] || muere "Hace falta un correo. Pásalo como argumento: bash instalar.sh tu@correo.com" 

  cat > .env <<EOF
# Generado por instalar.sh. No compartas este fichero: contiene tus claves.

# Solo sirve para emitir el primer token. Después deja de funcionar.
AURUM_API_KEY=$clave_arranque

# Cifra tus credenciales de broker. Si la pierdes, habrá que volver a
# introducirlas: no hay forma de recuperar lo ya cifrado.
AURUM_SECRET_KEY=$clave_cifrado

AURUM_OWNER_EMAIL=$correo
AURUM_DB_PATH=./aurum.db
AURUM_ALLOWED_ORIGINS=https://aurum-7cm.pages.dev,capacitor://localhost

# Desactivado a propósito: AURUM puede leer tu cartera y proponer, pero no
# mandará ninguna orden al broker mientras esto sea false.
AURUM_TRADING_ENABLED=false
AURUM_MAX_DAILY_EUR=1000

# Credenciales de Trade Republic. Puedes dejarlas vacías y ponerlas después
# desde la propia aplicación.
TR_PHONE=
TR_PIN=

# Opcionales.
ANTHROPIC_API_KEY=
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=
EOF
  chmod 600 .env
  bien "Configuración creada en backend/.env"
fi

# ── 5. Arranque ────────────────────────────────────────────────
azul 5 "Arrancando el backend"
if curl -sf --max-time 3 http://127.0.0.1:8000/health >/dev/null 2>&1; then
  bien "Ya estaba en marcha"
else
  nohup "$py" main.py > aurum-backend.log 2>&1 &
  listo=0
  for _ in $(seq 1 20); do
    sleep 2
    if curl -sf --max-time 3 http://127.0.0.1:8000/health >/dev/null 2>&1; then listo=1; break; fi
  done
  [ "$listo" = 1 ] || muere "El backend no ha respondido. Mira backend/aurum-backend.log para ver el error."
  bien "Backend en marcha"
fi

# ── 6. Tu token ────────────────────────────────────────────────
azul 6 "Creando tu token de acceso"
clave_arranque=$(grep '^AURUM_API_KEY=' .env | cut -d= -f2-)
correo=$(grep '^AURUM_OWNER_EMAIL=' .env | cut -d= -f2-)

respuesta=$(curl -s -X POST http://127.0.0.1:8000/admin/tokens \
  -H "X-AURUM-KEY: $clave_arranque" -H "Content-Type: application/json" \
  -d "{\"user_email\":\"$correo\",\"role\":\"owner\",\"scopes\":[\"read\",\"execute\",\"admin\"]}" || true)

token=$(printf '%s' "$respuesta" | "$py" -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true)

if [ -n "$token" ]; then
  bien "Token creado"
else
  aviso "No se ha creado: probablemente ya existía uno de antes."
  aviso "Si lo has perdido, borra backend/aurum.db y vuelve a ejecutar esto."
fi

# ── Resultado ──────────────────────────────────────────────────
printf '\n  ================================================\n'
printf '   Listo. Abre AURUM y ve a Ajustes -> Backend\n'
printf '  ================================================\n\n'
printf '   Dirección:  http://localhost:8000\n'
if [ -n "$token" ]; then
  printf '   Token:      %s\n\n' "$token"
  printf '   Cópialo ahora: no se puede volver a mostrar.\n'
fi
printf '\n   Esa dirección funciona si usas AURUM en ESTE ordenador.\n'
printf '   Para entrar desde el móvil, mira docs/BACKEND.md.\n\n'
