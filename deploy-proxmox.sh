#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  AURUM — backend en un contenedor de Proxmox
#
#  Crea un LXC, instala el backend, lo deja como servicio y —si quieres
#  usar AURUM desde el móvil— lo publica por https con Tailscale.
#
#  Ejecutar como root en el HOST de Proxmox. No hace falta descargar nada
#  antes ni tener el proyecto ahi: el script se trae lo que necesita.
#
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/padilla585projects/aurum/main/deploy-proxmox.sh)"
#
#  Si ya tienes el proyecto clonado, `bash deploy-proxmox.sh` usa esa copia.
#
#  Por qué https y no la IP de Tailscale a secas: AURUM se sirve por
#  https, y un navegador no deja que una página https pida datos a una
#  dirección http. Con `tailscale serve` el backend tiene certificado
#  propio y el móvil puede hablar con él.
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;36m'; N='\033[0m'
ok()    { echo -e "  ${G}OK${N}  $1"; }
paso()  { echo -e "\n${B}▶${N} $1"; }
aviso() { echo -e "  ${Y}!${N}   $1"; }
muere() { echo -e "\n  ${R}X${N}   $1\n"; exit 1; }

echo ""
echo -e "${Y}  AURUM — backend en Proxmox${N}"
echo   "  ─────────────────────────────"

command -v pct >/dev/null 2>&1 || muere "Esto va en el HOST de Proxmox, no dentro de un contenedor."
[ "$(id -u)" = 0 ] || muere "Hace falta ejecutarlo como root."

# Cuando esto se ejecuta con `curl | bash` no hay ningun fichero al lado: el
# script llega solo, por una tuberia. Antes eso obligaba a clonar el proyecto en
# el host de Proxmox a mano —con git, que no siempre esta instalado— y era el
# primer sitio donde la gente se atascaba. Ahora se trae el codigo el solo.
REPO=https://github.com/padilla585projects/aurum
DESCARGADO=""

# Si algo falla a mitad queda un contenedor a medio hacer que hay que borrar a
# mano, y para eso hay que saber que existe. Como lo ha creado este script y
# todavia no contiene nada del usuario, se deshace solo — pero diciendolo.
CREADO=""
limpiar() {
    local codigo=$?
    [ -n "$DESCARGADO" ] && rm -rf "$DESCARGADO"
    if [ "$codigo" != 0 ] && [ -n "$CREADO" ]; then
        echo ""
        aviso "Ha fallado a medias. Deshaciendo el contenedor $CREADO, que acababa de crear."
        pct stop "$CREADO" >/dev/null 2>&1 || true
        if pct destroy "$CREADO" >/dev/null 2>&1; then
            aviso "Contenedor $CREADO eliminado. Puedes volver a ejecutar esto."
        else
            aviso "No he podido eliminarlo. Bórralo con: pct destroy $CREADO"
        fi
    fi
    exit $codigo
}
trap limpiar EXIT

ORIGEN=""
if [ -f "${BASH_SOURCE[0]:-}" ]; then
    AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    [ -d "$AQUI/backend" ] && ORIGEN="$AQUI/backend"
fi

if [ -z "$ORIGEN" ]; then
    paso "Descargando AURUM"
    command -v curl >/dev/null 2>&1 || muere "Hace falta curl. Instálalo con: apt-get install -y curl"
    DESCARGADO=$(mktemp -d /tmp/aurum-src-XXXXXX)
    curl -fsSL "$REPO/archive/refs/heads/main.tar.gz"         | tar -xz -C "$DESCARGADO" --strip-components=1         || muere "No se ha podido descargar el proyecto desde $REPO"
    ORIGEN="$DESCARGADO/backend"
    [ -d "$ORIGEN" ] || muere "El paquete descargado no trae la carpeta backend/."
    ok "Descargado"
fi

# ── Lo que necesito saber ──────────────────────────────────────────
paso "Configuración"

# Proxmox comparte el espacio de IDs entre maquinas virtuales y contenedores,
# asi que no basta con mirar `pct`: un id puede estar ocupado por una VM. Se le
# pregunta al propio Proxmox cual es el siguiente libre.
ocupado() { pct status "$1" >/dev/null 2>&1 || qm status "$1" >/dev/null 2>&1; }

VMID=$(pvesh get /cluster/nextid 2>/dev/null || true)
if [ -z "$VMID" ]; then
    VMID=200
    while ocupado "$VMID"; do VMID=$((VMID+1)); done
fi
read -rp "  ID del contenedor [$VMID]: " r; VMID="${r:-$VMID}"
ocupado "$VMID" && muere "El ID $VMID ya lo usa una VM o un contenedor. Elige otro."

ALMACENES=$(pvesm status --content rootdir 2>/dev/null | tail -n +2 | awk '{print $1}')
[ -n "$ALMACENES" ] || muere "No hay almacenamiento para contenedores."
ALMACEN=$(echo "$ALMACENES" | head -1)
echo "  Almacenamientos: $(echo "$ALMACENES" | tr '\n' ' ')"
read -rp "  Cuál uso [$ALMACEN]: " r; ALMACEN="${r:-$ALMACEN}"

read -rp "  Memoria en MB [512]: " r; MEMORIA="${r:-512}"
read -rp "  Puente de red [vmbr0]: " r; PUENTE="${r:-vmbr0}"
read -rp "  Tu correo (el mismo con el que entras en AURUM): " CORREO
[ -n "$CORREO" ] || muere "Hace falta el correo: es el dueño del backend."

echo ""
echo "  ¿Vas a usar AURUM desde el móvil o desde otro dispositivo?"
echo "  Si contestas que sí, instalo Tailscale y publico el backend por https."
echo "  Si no, quedará accesible solo dentro de tu red local."
read -rp "  Instalar Tailscale [S/n]: " r
CON_TAILSCALE=true
case "${r:-s}" in [nN]*) CON_TAILSCALE=false;; esac

CLAVE_TS=""
if $CON_TAILSCALE; then
    echo ""
    echo "  Puedes pegar una clave de autenticación de Tailscale para que se"
    echo "  conecte solo (la generas en login.tailscale.com → Settings → Keys)."
    echo "  Si lo dejas en blanco, te daré un enlace para autorizarlo a mano."
    read -rp "  Clave de Tailscale (opcional): " CLAVE_TS
fi

# ── Plantilla ──────────────────────────────────────────────────────
paso "Plantilla de Debian"
PLANTILLA=$(pveam list local 2>/dev/null | awk '/debian-12/{print $1}' | head -1 || true)
if [ -z "$PLANTILLA" ]; then
    pveam update >/dev/null 2>&1 || true
    NOMBRE=$(pveam available --section system | awk '/debian-12-standard/{print $2}' | tail -1)
    [ -n "$NOMBRE" ] || muere "No hay plantilla de Debian 12 disponible."
    pveam download local "$NOMBRE" >/dev/null || muere "No se ha podido descargar la plantilla."
    PLANTILLA=$(pveam list local | awk '/debian-12/{print $1}' | head -1)
fi
ok "$(basename "$PLANTILLA")"

# ── Contenedor ─────────────────────────────────────────────────────
paso "Creando el contenedor $VMID"
pct create "$VMID" "$PLANTILLA" \
    --hostname aurum-backend \
    --memory "$MEMORIA" --cores 1 \
    --rootfs "${ALMACEN}:4" \
    --net0 "name=eth0,bridge=${PUENTE},ip=dhcp,firewall=0" \
    --unprivileged 1 --features nesting=1 \
    --ostype debian --onboot 1 --start 0 >/dev/null
CREADO="$VMID"
ok "Contenedor creado"

if $CON_TAILSCALE; then
    # Tailscale necesita /dev/net/tun, que un contenedor sin privilegios no
    # tiene por defecto. Sin esto, la VPN no levanta.
    cat >> "/etc/pve/lxc/${VMID}.conf" <<'EOF'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF
    ok "Acceso a /dev/net/tun concedido"
fi

pct start "$VMID" >/dev/null
for _ in $(seq 1 20); do pct exec "$VMID" -- true >/dev/null 2>&1 && break; sleep 2; done
pct exec "$VMID" -- true >/dev/null 2>&1 || muere "El contenedor no arranca."
ok "Contenedor en marcha"

# ── Sistema base ───────────────────────────────────────────────────
paso "Instalando lo necesario (tarda un par de minutos)"
pct exec "$VMID" -- bash -c "
    export DEBIAN_FRONTEND=noninteractive LC_ALL=C LANG=C
    apt-get update -qq
    apt-get install -y -qq python3 python3-venv python3-pip curl ca-certificates >/dev/null
" || muere "Fallo instalando paquetes base."
ok "Sistema preparado"

# ── Copiar el backend entero ───────────────────────────────────────
# Se copia la carpeta completa: el backend son varios modulos que se
# importan entre si, y copiar solo unos cuantos lo deja sin arrancar.
paso "Copiando el backend"
DESTINO=/opt/aurum-backend
pct exec "$VMID" -- mkdir -p "$DESTINO"
PAQUETE=$(mktemp /tmp/aurum-XXXXXX.tar.gz)
# --owner/--group a 0: si el paquete se hace en Windows lleva un uid que no
# existe en Linux, y un contenedor sin privilegios no puede aplicarlo.
tar -czf "$PAQUETE" -C "$ORIGEN" --owner=0 --group=0 --numeric-owner \
    --exclude='.venv' --exclude='__pycache__' --exclude='.pytest_cache' \
    --exclude='.env' \
    --exclude='aurum.db*' --exclude='tests' .
pct push "$VMID" "$PAQUETE" /tmp/aurum.tar.gz >/dev/null
pct exec "$VMID" -- tar -xzf /tmp/aurum.tar.gz -C "$DESTINO" --no-same-owner
pct exec "$VMID" -- rm -f /tmp/aurum.tar.gz
rm -f "$PAQUETE"
ok "Copiado en $DESTINO"

paso "Instalando dependencias de Python"
pct exec "$VMID" -- bash -c "
    cd $DESTINO
    python3 -m venv venv
    ./venv/bin/pip install --quiet --upgrade pip
    ./venv/bin/pip install --quiet -r requirements.txt
" || muere "Fallo instalando dependencias de Python."
ok "Dependencias instaladas"

# ── Configuración ──────────────────────────────────────────────────
paso "Generando la configuración"
CLAVE_ARRANQUE=$(pct exec "$VMID" -- python3 -c 'import secrets; print(secrets.token_hex(32))')
CLAVE_CIFRADO=$(pct exec "$VMID" -- python3 -c 'import os,base64; print(base64.b64encode(os.urandom(32)).decode())')

pct exec "$VMID" -- bash -c "cat > $DESTINO/.env <<EOF
# Generado por deploy-proxmox.sh. Contiene tus claves: no lo compartas.
AURUM_API_KEY=${CLAVE_ARRANQUE}
AURUM_SECRET_KEY=${CLAVE_CIFRADO}
AURUM_OWNER_EMAIL=${CORREO}
AURUM_DB_PATH=${DESTINO}/aurum.db
AURUM_ALLOWED_ORIGINS=https://aurum-7cm.pages.dev,capacitor://localhost

# Desactivado a proposito: AURUM lee tu cartera y propone, pero no manda
# ninguna orden al broker mientras esto sea false.
AURUM_TRADING_ENABLED=false
AURUM_MAX_DAILY_EUR=1000

# Se rellenan desde la propia aplicacion, en Ajustes.
TR_PHONE=
TR_PIN=
ANTHROPIC_API_KEY=
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=
EOF"
pct exec "$VMID" -- chmod 600 "$DESTINO/.env"
ok "Configuración creada"

# ── Servicio ───────────────────────────────────────────────────────
paso "Dejándolo como servicio"
pct exec "$VMID" -- bash -c "cat > /etc/systemd/system/aurum-backend.service <<'EOF'
[Unit]
Description=AURUM — backend privado
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/aurum-backend
ExecStart=/opt/aurum-backend/venv/bin/python main.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF"
pct exec "$VMID" -- systemctl daemon-reload
pct exec "$VMID" -- systemctl enable --now aurum-backend >/dev/null 2>&1

listo=false
for _ in $(seq 1 20); do
    if pct exec "$VMID" -- curl -sf --max-time 3 http://127.0.0.1:8000/health >/dev/null 2>&1; then listo=true; break; fi
    sleep 2
done
$listo || muere "El backend no responde. Mira: pct exec $VMID -- journalctl -u aurum-backend -n 40"
ok "Arranca solo al encender el contenedor"

# ── Tailscale ──────────────────────────────────────────────────────
DIRECCION=""
if $CON_TAILSCALE; then
    paso "Conectando Tailscale"
    pct exec "$VMID" -- bash -c "curl -fsSL https://tailscale.com/install.sh | sh -s -- -q >/dev/null 2>&1"
    pct exec "$VMID" -- systemctl enable --now tailscaled >/dev/null 2>&1
    sleep 3

    if [ -n "$CLAVE_TS" ]; then
        pct exec "$VMID" -- tailscale up --authkey "$CLAVE_TS" --hostname aurum-backend >/dev/null 2>&1             || aviso "La clave no ha servido; habrá que autorizarlo a mano."
    else
        # `tailscale up` se queda esperando a que autorices, y no suelta la
        # salida hasta entonces. Si se lee con una tuberia, el enlace no
        # aparece hasta despues de haberlo usado — es decir, nunca. Se lanza en
        # segundo plano y se lee el enlace del registro.
        pct exec "$VMID" -- bash -c             "rm -f /tmp/ts-up.log; setsid tailscale up --hostname aurum-backend >/tmp/ts-up.log 2>&1 < /dev/null &"             >/dev/null 2>&1

        ENLACE=""
        for _ in $(seq 1 20); do
            sleep 2
            ENLACE=$(pct exec "$VMID" -- grep -om1 'https://login[^[:space:]]*' /tmp/ts-up.log 2>/dev/null || true)
            [ -n "$ENLACE" ] && break
        done

        if [ -z "$ENLACE" ]; then
            aviso "No he conseguido el enlace de autorización. Hazlo después con:"
            aviso "  pct exec $VMID -- tailscale up"
        else
            echo ""
            echo "  Abre este enlace en el navegador y autoriza el equipo:"
            echo -e "    ${B}${ENLACE}${N}"
            echo ""
            printf "  Esperando"
            # Se detecta solo en cuanto autorizas: nadie tiene que volver aqui
            # a pulsar una tecla. Cinco minutos de margen, y si no, se sigue.
            for _ in $(seq 1 150); do
                if pct exec "$VMID" -- tailscale status >/dev/null 2>&1; then break; fi
                printf "."
                sleep 2
            done
            echo ""
        fi
    fi

    if pct exec "$VMID" -- tailscale status >/dev/null 2>&1; then
        ok "Equipo autorizado en tu tailnet"

        DOMINIO=$(pct exec "$VMID" -- tailscale status --json 2>/dev/null             | python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)

        # Esto es lo que hace que funcione desde el movil: certificado propio y
        # https, en vez de la IP de Tailscale por http. Exige que la tailnet
        # tenga los certificados activados, y ese es el tropiezo mas comun —
        # asi que si falla se dice exactamente donde se activa.
        SALIDA_SERVE=$(pct exec "$VMID" -- tailscale serve --bg --https=443 http://127.0.0.1:8000 2>&1 || true)

        if pct exec "$VMID" -- tailscale serve status 2>/dev/null | grep -q 'https://'; then
            [ -n "$DOMINIO" ] && DIRECCION="https://$DOMINIO"
            ok "Publicado en ${DIRECCION:-la tailnet}"

            # Comprobar que responde de verdad, no solo que el mandato no falló.
            if [ -n "$DIRECCION" ] && curl -sf --max-time 10 "$DIRECCION/health" >/dev/null 2>&1; then
                ok "Comprobado: responde por https"
            else
                aviso "Publicado, pero aún no responde desde aquí. Suele ser el certificado,"
                aviso "que tarda un minuto la primera vez."
            fi
        else
            aviso "No se ha podido publicar por https."
            echo "$SALIDA_SERVE" | head -3 | sed 's/^/      /'
            aviso "Casi siempre es esto: entra en login.tailscale.com → DNS y activa"
            aviso "«HTTPS Certificates». Después, aquí:"
            aviso "  pct exec $VMID -- tailscale serve --bg --https=443 http://127.0.0.1:8000"
        fi
    else
        aviso "Tailscale no ha quedado conectado. Puedes hacerlo después con:"
        aviso "  pct exec $VMID -- tailscale up"
    fi
fi

[ -n "$DIRECCION" ] || DIRECCION="http://$(pct exec "$VMID" -- hostname -I | awk '{print $1}'):8000"

# ── Token ──────────────────────────────────────────────────────────
paso "Creando tu token de acceso"
# Se emiten dos tokens, y la diferencia importa:
#
#   · Uno de administracion, que puede emitir mas tokens y manejar los agentes.
#     Se queda dentro del contenedor, en .env, y no se pega en ninguna parte.
#   · Uno de solo lectura, que es el que va en la aplicacion. Con el se ve la
#     cartera y nada mas: si alguna vez se filtra, el daño es leer.
#
# Sin el de administracion no habria forma de emitir mas: la clave de arranque
# solo funciona mientras no existe ningun token.
emitir() {
    pct exec "$VMID" -- curl -s -X POST http://127.0.0.1:8000/admin/tokens \
        -H "X-AURUM-KEY: $1" -H 'Content-Type: application/json' \
        -d "$2" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true
}

ADMIN=$(emitir "${CLAVE_ARRANQUE}" "{\"user_email\":\"${CORREO}\",\"role\":\"owner\",\"scopes\":[\"read\",\"execute\",\"admin\"],\"label\":\"administracion\"}")

if [ -n "$ADMIN" ]; then
    pct exec "$VMID" -- sh -c 'grep -q "^AURUM_ADMIN_TOKEN=" "$1/.env" || {
        echo ""
        echo "# Token de administracion. Sirve para emitir mas tokens."
        echo "AURUM_ADMIN_TOKEN=$2"
    } >> "$1/.env"' _ "${DESTINO}" "$ADMIN"
    TOKEN=$(emitir "$ADMIN" "{\"user_email\":\"${CORREO}\",\"role\":\"user\",\"scopes\":[\"read\"],\"label\":\"aplicacion\"}")
    ok "Tokens creados"
else
    TOKEN=""
    aviso "No se han podido crear los tokens. ¿Ya existía uno de antes?"
fi

# A partir de aqui el contenedor ya es utilizable: aunque falle algo de lo que
# queda, borrarlo seria peor que dejarlo.
CREADO=""

# ── Resumen ────────────────────────────────────────────────────────
echo ""
echo -e "${G}  ══════════════════════════════════════════════${N}"
echo -e "${G}   Listo. Abre AURUM → Ajustes → Backend${N}"
echo -e "${G}  ══════════════════════════════════════════════${N}"
echo ""
echo -e "   Dirección:  ${B}${DIRECCION}${N}"
[ -n "$TOKEN" ] && echo -e "   Token:      ${B}${TOKEN}${N}   (solo lectura)"
echo ""
[ -n "$TOKEN" ] && echo -e "   ${Y}Copia el token ahora: no se puede volver a mostrar.${N}\n"
if ! $CON_TAILSCALE; then
    echo -e "   ${Y}Sin Tailscale, esa dirección es http y solo funciona dentro de tu${N}"
    echo -e "   ${Y}red local. Desde el móvil el navegador la bloqueará.${N}\n"
fi
echo "   Órdenes de compra y venta: desactivadas. Para activarlas, edita"
echo "   AURUM_TRADING_ENABLED en ${DESTINO}/.env dentro del contenedor."
echo ""
echo "   Comandos útiles:"
echo "     pct exec $VMID -- systemctl status aurum-backend"
echo "     pct exec $VMID -- journalctl -u aurum-backend -f"
echo ""
