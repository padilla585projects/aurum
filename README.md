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

## Desarrollo local

```bash
# 1. Clona el repo
git clone https://github.com/padilla585projects/aurum.git
cd aurum

# 2. Instala dependencias
npm install

# 3. Configura tu API key de Anthropic
cp .env.example .env
# Edita .env y añade: VITE_ANTHROPIC_API_KEY=sk-ant-...

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

En **Cloudflare Dashboard → Pages → aurum → Settings → Environment variables** añade:
```
ANTHROPIC_API_KEY = sk-ant-tu-clave
```

> En producción la API key la gestiona el proxy (`functions/api/chat.ts`) y nunca llega al navegador.

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
├── src/
│   └── App.tsx              # Aplicación completa (componente raíz)
├── functions/
│   └── api/chat.ts          # Proxy seguro → Anthropic API
├── public/
│   └── manifest.json        # PWA manifest
├── index.html
├── vite.config.ts
├── wrangler.toml            # Config Cloudflare Pages
└── capacitor.config.ts      # Config APK Android
```

---

## Seguridad

- La `ANTHROPIC_API_KEY` **nunca** se incluye en el bundle del frontend
- En producción todas las llamadas van a través de `/api/chat` (Cloudflare Function)
- En desarrollo se usa `VITE_ANTHROPIC_API_KEY` del `.env` local (nunca se sube al repo)

---

## Licencia

[MIT](LICENSE) © 2026 padilla585projects
