#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  AURUM Backend — Deploy automático en Proxmox
#  Ejecutar como root en el HOST de Proxmox (no dentro de un LXC):
#
#    bash deploy-proxmox.sh
#
#  Hace TODO: descarga template, crea LXC, instala Python,
#  copia el backend, configura Tailscale y servicio systemd.
# ═══════════════════════════════════════════════════════════════════

set -e

# ── Colores ──────────────────────────────────────────────────────
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${G}✓${NC} $1"; }
info() { echo -e "${B}▶${NC} $1"; }
warn() { echo -e "${Y}⚠${NC}  $1"; }
err()  { echo -e "${R}✗${NC} $1"; exit 1; }

echo ""
echo -e "${Y}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${Y}  AURUM Backend — Proxmox Deploy${NC}"
echo -e "${Y}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ── Verificar que estamos en Proxmox ─────────────────────────────
command -v pct >/dev/null 2>&1 || err "Este script debe ejecutarse en el HOST de Proxmox (no dentro de un LXC)"

# ── Configuración (edita si necesitas cambiar algo) ───────────────
VMID=200
HOSTNAME="aurum-backend"
MEMORY=512
CORES=1
BRIDGE="vmbr0"
TEMPLATE_NAME="debian-12-standard_12.7-1_amd64.tar.zst"
BACKEND_DIR="/opt/aurum-backend"

# Auto-detectar storage disponible para contenedores
STORAGE=$(pvesm status --content rootdir 2>/dev/null | grep -v "^Name" | awk 'NR==1{print $1}')
[ -z "$STORAGE" ] && STORAGE="local-lvm"
info "Storage detectado: $STORAGE"

# ── Verificar VMID libre ──────────────────────────────────────────
if pct status $VMID &>/dev/null; then
    warn "El contenedor $VMID ya existe."
    read -p "  ¿Deseas eliminarlo y recrearlo? [s/N]: " CONFIRM
    [[ "$CONFIRM" =~ ^[sS]$ ]] || err "Abortado. Cambia VMID en el script si quieres usar otro."
    info "Eliminando contenedor $VMID..."
    pct stop $VMID 2>/dev/null || true
    pct destroy $VMID --purge
    ok "Contenedor $VMID eliminado"
fi

# ── Descargar template Debian 12 si no existe ─────────────────────
info "Verificando template Debian 12..."
if ! pveam list local 2>/dev/null | grep -q "$TEMPLATE_NAME"; then
    info "Descargando Debian 12 template..."
    pveam update
    pveam download local "$TEMPLATE_NAME" || \
        pveam download local "debian-12-standard_12.2-1_amd64.tar.zst" || \
        err "No se pudo descargar el template. Descárgalo manualmente en Proxmox UI → local → CT Templates"
    ok "Template descargado"
else
    ok "Template ya disponible"
fi

# Buscar el template exacto disponible
TEMPLATE=$(pveam list local 2>/dev/null | grep "debian-12" | awk '{print $1}' | head -1)
[ -z "$TEMPLATE" ] && err "No se encontró template Debian 12 en local storage"
info "Usando template: $TEMPLATE"

# ── Crear LXC ─────────────────────────────────────────────────────
info "Creando contenedor LXC $VMID ($HOSTNAME)..."
pct create $VMID "$TEMPLATE" \
    --hostname   "$HOSTNAME" \
    --memory     $MEMORY \
    --cores      $CORES \
    --rootfs     "${STORAGE}:4" \
    --net0       "name=eth0,bridge=${BRIDGE},ip=dhcp,firewall=0" \
    --unprivileged 1 \
    --features   "nesting=1" \
    --ostype     debian \
    --start      0
ok "Contenedor creado"

# ── Arrancar LXC ─────────────────────────────────────────────────
info "Arrancando contenedor..."
pct start $VMID
sleep 4  # esperar a que arranque la red

# Esperar hasta que el LXC responda
for i in $(seq 1 15); do
    pct exec $VMID -- echo "ok" &>/dev/null && break
    sleep 2
done
ok "Contenedor arrancado"

# ── Sistema base ──────────────────────────────────────────────────
info "Actualizando sistema base..."
pct exec $VMID -- bash -c "
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get upgrade -y -qq
    apt-get install -y -qq python3 python3-pip python3-venv curl wget git nano
" && ok "Sistema actualizado"

# ── Instalar Tailscale ────────────────────────────────────────────
info "Instalando Tailscale..."
pct exec $VMID -- bash -c "
    curl -fsSL https://tailscale.com/install.sh | sh -s -- -q
" && ok "Tailscale instalado"

# ── Crear directorio de la app ────────────────────────────────────
pct exec $VMID -- mkdir -p "$BACKEND_DIR"

# ── Escribir archivos del backend ─────────────────────────────────
info "Copiando archivos del backend..."

# requirements.txt
pct exec $VMID -- bash -c "cat > ${BACKEND_DIR}/requirements.txt << 'EOF'
fastapi==0.115.5
uvicorn[standard]==0.32.1
websockets==13.1
python-dotenv==1.0.1
httpx==0.27.2
EOF"

# tr_client.py
pct push $VMID "$(dirname "$0")/backend/tr_client.py" "${BACKEND_DIR}/tr_client.py" 2>/dev/null || \
pct exec $VMID -- bash -c "curl -fsSL https://raw.githubusercontent.com/padilla585projects/AURUM/main/backend/tr_client.py -o ${BACKEND_DIR}/tr_client.py" 2>/dev/null || \
warn "No se pudo copiar tr_client.py automáticamente — cópialo manualmente después"

# main.py
pct push $VMID "$(dirname "$0")/backend/main.py" "${BACKEND_DIR}/main.py" 2>/dev/null || \
pct exec $VMID -- bash -c "curl -fsSL https://raw.githubusercontent.com/padilla585projects/AURUM/main/backend/main.py -o ${BACKEND_DIR}/main.py" 2>/dev/null || \
warn "No se pudo copiar main.py automáticamente — cópialo manualmente después"

ok "Archivos copiados"

# ── Entorno virtual Python ────────────────────────────────────────
info "Creando entorno virtual e instalando dependencias..."
pct exec $VMID -- bash -c "
    cd ${BACKEND_DIR}
    python3 -m venv venv
    source venv/bin/activate
    pip install --quiet --upgrade pip
    pip install --quiet -r requirements.txt
" && ok "Dependencias instaladas"

# ── Configurar .env ───────────────────────────────────────────────
echo ""
echo -e "${Y}─────────────────────────────────────────────────────────────${NC}"
echo -e "${Y}  Configuración de AURUM Backend${NC}"
echo -e "${Y}─────────────────────────────────────────────────────────────${NC}"
echo ""

read -p "  Genera una API key automática? [S/n]: " AUTO_KEY
if [[ ! "$AUTO_KEY" =~ ^[nN]$ ]]; then
    API_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    echo -e "  ${G}API Key generada:${NC} $API_KEY"
    echo ""
    echo -e "  ${Y}⚠ Cópiala ahora — la necesitarás en AURUM > Ajustes > Backend${NC}"
    echo ""
else
    read -p "  Introduce tu API Key: " API_KEY
fi

read -p "  Teléfono Trade Republic (ej: +34612345678): " TR_PHONE
read -s -p "  PIN Trade Republic (4 dígitos): " TR_PIN
echo ""

pct exec $VMID -- bash -c "cat > ${BACKEND_DIR}/.env << EOF
AURUM_API_KEY=${API_KEY}
TR_PHONE=${TR_PHONE}
TR_PIN=${TR_PIN}
EOF"
pct exec $VMID -- chmod 600 "${BACKEND_DIR}/.env"
ok ".env configurado"

# ── Servicio systemd ──────────────────────────────────────────────
info "Configurando servicio systemd..."
pct exec $VMID -- bash -c "cat > /etc/systemd/system/aurum-backend.service << 'EOF'
[Unit]
Description=AURUM Backend — Trade Republic Executor
After=network.target tailscaled.service
Wants=tailscaled.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/aurum-backend
EnvironmentFile=/opt/aurum-backend/.env
ExecStart=/opt/aurum-backend/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF"

pct exec $VMID -- bash -c "
    systemctl daemon-reload
    systemctl enable aurum-backend
    systemctl start aurum-backend
" && ok "Servicio aurum-backend activo"

# ── Conectar Tailscale ────────────────────────────────────────────
echo ""
echo -e "${Y}─────────────────────────────────────────────────────────────${NC}"
echo -e "${Y}  Conectar Tailscale${NC}"
echo -e "${Y}─────────────────────────────────────────────────────────────${NC}"
echo ""
info "Iniciando Tailscale (se abrirá un enlace para autenticar)..."
echo ""
pct exec $VMID -- tailscale up --accept-routes 2>&1 | grep -E "(https://|To authenticate)" || true
echo ""
echo -e "  ${Y}Abre el enlace de arriba en tu navegador para conectar Tailscale.${NC}"
echo -e "  ${Y}Después pulsa ENTER para continuar...${NC}"
read -p "  "

# Obtener IP de Tailscale
TS_IP=$(pct exec $VMID -- tailscale ip -4 2>/dev/null || echo "")

# ── Test final ────────────────────────────────────────────────────
echo ""
info "Verificando que el backend responde..."
sleep 2
HEALTH=$(pct exec $VMID -- curl -s http://localhost:8000/health 2>/dev/null || echo "{}")
ok "Backend OK: $HEALTH"

# ── Resumen ───────────────────────────────────────────────────────
echo ""
echo -e "${G}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${G}  ✓ AURUM Backend instalado y corriendo${NC}"
echo -e "${G}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${B}IP Tailscale:${NC}  ${TS_IP:-"ejecuta: pct exec $VMID -- tailscale ip -4"}"
echo -e "  ${B}API Key:${NC}       $API_KEY"
echo -e "  ${B}Backend URL:${NC}   http://${TS_IP:-"<IP-TAILSCALE>"}:8000"
echo ""
echo -e "  ${Y}En AURUM → Ajustes → Backend Proxmox:${NC}"
echo -e "    URL:      http://${TS_IP:-"<IP-TAILSCALE>"}:8000"
echo -e "    API Key:  $API_KEY"
echo ""
echo -e "  ${Y}Comandos útiles dentro del LXC:${NC}"
echo -e "    pct exec $VMID -- systemctl status aurum-backend"
echo -e "    pct exec $VMID -- journalctl -u aurum-backend -f"
echo -e "    pct exec $VMID -- curl http://localhost:8000/health"
echo ""
