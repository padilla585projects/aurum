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

Crea la base de datos y aplica las migraciones:

```bash
npx wrangler d1 create aurum          # pega el database_id en wrangler.toml
npx wrangler d1 migrations apply aurum --remote
```

En **Cloudflare Dashboard → Pages → aurum → Settings → Environment variables** añade:

```
AURUM_SIGNING_SECRET   = <32+ bytes aleatorios>   # obligatoria
AURUM_BOOTSTRAP_SECRET = <secreto de arranque>    # crea la cuenta de propietario
AURUM_ALLOWED_ORIGINS  = https://tu-dominio       # sin comodines
AURUM_PUBLIC_URL       = https://tu-dominio
ANTHROPIC_API_KEY      = sk-ant-tu-clave
OPENAI_API_KEY         = sk-...                   # opcional
DEEPSEEK_API_KEY       = sk-...                   # opcional
GOOGLE_CLIENT_ID       = ...                      # opcional, activa el acceso con Google
GOOGLE_CLIENT_SECRET   = ...
```

Para el acceso con Google (web y APK), sigue [docs/GOOGLE-OAUTH.md](docs/GOOGLE-OAUTH.md).

> Las claves de IA las gestionan los proxies de `functions/api/` y nunca llegan al navegador. Desde la versión multiusuario, **ninguna ruta de `/api` responde sin sesión**: hay autenticación, CORS con allowlist y límite de peticiones por usuario.

### Desarrollo local con Functions

`vite dev` no ejecuta las Cloudflare Functions, así que no hay sesión ni estado. Para probar la aplicación completa:

```bash
npm run build && npx wrangler d1 migrations apply aurum --local && npx wrangler pages dev dist --port 8788
```

Las variables locales van en `.dev.vars` (ignorado por git).

---

## Backend privado (operaciones y automatización)

El directorio `backend/` contiene un servicio FastAPI independiente para Trade Republic, alertas de Telegram y agentes locales. Está pensado para una red privada (por ejemplo, Tailscale), no para Internet pública.

```bash
cd backend
cp .env.example .env
# configura AURUM_SECRET_KEY, AURUM_OWNER_EMAIL, AURUM_ALLOWED_ORIGINS y las integraciones
python -m pip install -r requirements.txt
python main.py
```

El backend tiene identidad **por usuario**. `AURUM_API_KEY` ya no es la credencial de uso diario: solo emite el primer token de propietario y deja de funcionar en cuanto existe uno.

```bash
# Primer token (una sola vez)
curl -X POST http://TU-BACKEND:8000/admin/tokens   -H "X-AURUM-KEY: $AURUM_API_KEY" -H "Content-Type: application/json"   -d '{"user_email":"tu@correo.com","role":"owner","scopes":["read","execute","admin"]}'
```

A partir de ahí, el propietario emite un token por persona con rol y ámbitos (`read`, `execute`, `admin`), revocables por separado. Cada usuario guarda sus credenciales de Trade Republic con `PUT /broker/credentials`; se cifran con AES-256-GCM y cada uno tiene su propia sesión de broker.

**La ejecución de órdenes viene desactivada** (`AURUM_TRADING_ENABLED=false`). Cuando se activa, toda orden pasa por doble confirmación (`POST /orders/prepare` → `POST /invest`), clave de idempotencia y límite diario acumulado.

Para conectarlo con tu broker paso a paso, incluido cómo llegar desde el móvil, está [docs/BACKEND.md](docs/BACKEND.md). Cada usuario instala el suyo: **no es un servidor compartido**, y así las credenciales de banca de cada uno se quedan en su propia máquina.

Consulta [docs/HANDOFF.md](docs/HANDOFF.md) para el estado técnico, límites actuales y prioridades de continuación.

---

## Pruebas

```bash
npm test              # Pages Functions, dentro de workerd y con una D1 real
npm run test:backend  # backend FastAPI, con SQLite desechable
npm run check         # las dos, más el build y la comprobación de tipos
```

Las del edge no usan dobles: corren en el mismo runtime que Cloudflare y cada
petición pasa por el middleware, así que cubren sesión, CORS, CSRF y límites. Las
del backend no salen a la red ni tocan `backend/aurum.db`. Ambas se ejecutan en
CI en cada pull request. Detalle en [docs/TESTING.md](docs/TESTING.md).

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
├── functions/api/           # Proxies de IA, auth, estado y middleware de sesión
├── functions/_lib/          # Cripto, sesiones, límites y utilidades del edge
├── db/migrations/           # Esquema D1 (usuarios, sesiones, estado, auditoría)
├── backend/                 # FastAPI: broker, automatización, Telegram y agente local
├── test/edge/               # Pruebas de las Functions (Vitest sobre workerd)
├── backend/tests/           # Pruebas del backend (pytest)
├── docs/HANDOFF.md          # Estado técnico y plan de continuación
├── docs/TESTING.md          # Qué cubre cada suite y cómo ejecutarlas
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
- Todas las rutas de `/api` exigen sesión, con CORS restringido a una allowlist y límite de peticiones por usuario.
- El registro es solo por invitación; los códigos y los tokens de sesión se guardan hasheados.
- Los proxies de IA solo aceptan modelos de una lista cerrada y topan los tokens de salida.
- El estado de cada usuario está aislado en D1, con cuotas de tamaño por cuenta.
- El backend privado usa tokens por usuario con rol y ámbitos, y cifra las credenciales de broker en reposo.
- Las operaciones autónomas validan los importes y no pueden superar el presupuesto configurado.
- El agente local no ejecuta comandos de shell; admite únicamente una lista cerrada de acciones.
- El Computer Agent no envía credenciales al proveedor de IA, aunque sigue siendo experimental: no debe usarse para acciones financieras irreversibles sin confirmación humana.

---

## Licencia

[MIT](LICENSE) © 2026 padilla585projects
