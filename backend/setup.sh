#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  AURUM Backend — Setup para LXC en Proxmox (Debian 12)
#  Ejecutar como root dentro del contenedor:
#    bash setup.sh
# ═══════════════════════════════════════════════════════════════════

set -e

echo "▶ Actualizando sistema..."
apt-get update -qq && apt-get upgrade -y -qq

echo "▶ Instalando Python 3.11 + pip..."
apt-get install -y -qq python3 python3-pip python3-venv curl

echo "▶ Instalando Tailscale..."
curl -fsSL https://tailscale.com/install.sh | sh

echo "▶ Creando directorio de la app..."
mkdir -p /opt/aurum-backend
cd /opt/aurum-backend

echo "▶ Copiando archivos (asumiendo que están en el directorio actual)..."
# Si ejecutas esto desde dentro del LXC después de copiar los archivos:
# cp /tmp/aurum-backend/* /opt/aurum-backend/

echo "▶ Creando entorno virtual Python..."
python3 -m venv venv
source venv/bin/activate

echo "▶ Instalando dependencias Python..."
pip install --quiet -r requirements.txt

echo "▶ Configurando variables de entorno..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo ""
    echo "⚠️  IMPORTANTE: edita /opt/aurum-backend/.env con tus datos:"
    echo "   nano /opt/aurum-backend/.env"
    echo ""
fi

echo "▶ Instalando servicio systemd..."
cat > /etc/systemd/system/aurum-backend.service << 'EOF'
[Unit]
Description=AURUM Backend — Trade Republic Executor
After=network.target tailscaled.service
Wants=tailscaled.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/aurum-backend
EnvironmentFile=/opt/aurum-backend/.env
ExecStart=/opt/aurum-backend/venv/bin/python main.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable aurum-backend

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " ✓ Setup completado"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo " Próximos pasos:"
echo ""
echo " 1. Conecta Tailscale:"
echo "    tailscale up"
echo ""
echo " 2. Edita la configuración:"
echo "    nano /opt/aurum-backend/.env"
echo ""
echo " 3. Arranca el backend:"
echo "    systemctl start aurum-backend"
echo "    systemctl status aurum-backend"
echo ""
echo " 4. Comprueba que funciona:"
echo "    curl http://localhost:8000/health"
echo ""
echo " 5. Anota tu IP de Tailscale:"
echo "    tailscale ip -4"
echo "    → Esa IP va en AURUM > Ajustes > Backend URL"
echo ""
