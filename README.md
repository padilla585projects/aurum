# AURUM — Investment AI Advisor

> Tu asesor de inversión personal con inteligencia artificial

[![Deploy](https://img.shields.io/badge/Live-aurum--7cm.pages.dev-c9a84c?style=flat-square&logo=cloudflare)](https://aurum-7cm.pages.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react)](https://react.dev/)

---

## Características

| Módulo | Descripción |
|--------|-------------|
| 💬 **Chat** | 4 agentes IA especializados: AURUM (general), MACRO, RIESGO y FISCAL |
| 📁 **Cartera** | Tracker de posiciones con P&L en tiempo real y gráfico de distribución |
| 🔬 **Research** | Investigación profunda en 5 fases + informe profesional sintetizado |
| 🧮 **Simulador** | Proyección patrimonial con interés compuesto y aportaciones periódicas |

**Perfiles de riesgo:** Conservador · Moderado · Agresivo

**Búsqueda web en tiempo real** — los agentes buscan datos actualizados antes de responder.

---

## Stack

- **Frontend:** React 18 + Vite + TypeScript
- **Gráficos:** Recharts
- **Hosting:** Cloudflare Pages
- **Backend (proxy API):** Cloudflare Functions
- **Móvil:** Capacitor (APK Android)
- **IA:** Claude (Anthropic) con web_search

---

## Desarrollo local (frontend)

```bash
# 1. Clona el repo
git clone https://github.com/padilla585projects/aurum.git
cd aurum

# 2. Instala dependencias
npm install

# 3. Configura claves de desarrollo (solo local)
cp .env.example .env
# Edita .env y añade las claves VITE_* que vayas a usar

# 4. Arranca
npm run dev
# → http://localhost:5173
```

---

## Deploy en Cloudflare Pages

```bash
# Login (solo la primera vez)
npx wrangler login

# Build + deploy
npm run deploy
```

En **Cloudflare Dashboard → Pages → aurum → Settings → Environment variables** añade las claves que vayas a habilitar:
```
ANTHROPIC_API_KEY = sk-ant-tu-clave
OPENAI_API_KEY = sk-...       # opcional
DEEPSEEK_API_KEY = sk-...     # opcional
```

> En producción las claves las gestionan los proxies de `functions/api/`; nunca llegan al navegador. Antes de exponer la aplicación públicamente, protege esos endpoints con autenticación y rate limiting.

---

## Backend privado (operaciones y automatización)

El directorio `backend/` contiene un servicio FastAPI independiente para Trade Republic, alertas de Telegram y agentes locales. Está pensado para una red privada (por ejemplo, Tailscale), no para Internet pública.

```bash
cd backend
cp .env.example .env
# configura AURUM_API_KEY, AURUM_ALLOWED_ORIGINS y las integraciones necesarias
python -m pip install -r requirements.txt
python main.py
```

Define `AURUM_ALLOWED_ORIGINS` con las URLs exactas desde las que se utilizará el backend. La clave `AURUM_API_KEY` es obligatoria en todas las rutas sensibles.

Consulta [docs/HANDOFF.md](docs/HANDOFF.md) para el estado técnico, límites actuales y prioridades de continuación.

---

## Generar APK Android

```bash
# Requiere Android Studio instalado
npm run android
```

Pasos en Android Studio: `Build → Generate Signed Bundle/APK → APK`

El APK quedará en `android/app/build/outputs/apk/`.

---

## Estructura del proyecto

```
aurum/
├── src/                     # UI React y núcleo NEXUS (routing IA, memoria, tokens)
├── functions/api/           # Proxies Cloudflare para Anthropic, OpenAI, DeepSeek y mercado
├── backend/                 # FastAPI: broker, automatización, Telegram y agente local
├── docs/HANDOFF.md          # Estado técnico y plan de continuación
├── public/
│   └── manifest.json        # PWA manifest
├── index.html
├── vite.config.ts
├── wrangler.toml            # Config Cloudflare Pages
└── capacitor.config.ts      # Config APK Android
```

---

## Seguridad

- Las claves de proveedores no se incluyen en el bundle de producción.
- Las Functions productivas son `/api/anthropic`, `/api/openai` y `/api/deepseek`.
- El backend restringe CORS mediante `AURUM_ALLOWED_ORIGINS` y exige `AURUM_API_KEY`.
- Las operaciones autónomas validan los importes y no pueden superar el presupuesto configurado.
- El agente local no ejecuta comandos de shell; admite únicamente una lista cerrada de acciones.
- El Computer Agent no envía credenciales al proveedor de IA, aunque sigue siendo experimental: no debe usarse para acciones financieras irreversibles sin confirmación humana.

---

## Licencia

[MIT](LICENSE) © 2026 padilla585projects
