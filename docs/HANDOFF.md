# Continuidad del proyecto AURUM

Actualizado: 2026-08-18

## Qué es

AURUM es una aplicación de asesoramiento y seguimiento de inversiones. Combina una SPA React/PWA, proxies de IA en Cloudflare Pages y un backend FastAPI privado para integración con Trade Republic, automatización y Telegram.

## Modelo de acceso: multiusuario, despliegue privado

La decisión está tomada: **multiusuario en la arquitectura, sin publicar todavía**. En la práctica:

- El registro es **cerrado por invitación**. No existe alta abierta en ninguna vía.
- La primera cuenta de la instalación se crea con `AURUM_BOOTSTRAP_SECRET` y recibe el rol `owner`. Esa vía se cierra sola en cuanto existe un usuario.
- Dos formas de acceder: correo + contraseña, y Google. Ambas terminan en la misma sesión.
- El propietario emite invitaciones desde Ajustes → Cuenta. El código se muestra una sola vez.

## Arquitectura de identidad

Hay **dos planos de identidad**, deliberadamente separados, porque el edge y el backend privado son sistemas distintos:

| Plano | Dónde | Credencial | Para qué |
| --- | --- | --- | --- |
| Aplicación | Cloudflare Pages + D1 | Cookie de sesión httpOnly (o Bearer en la APK) | Entrar en AURUM, usar la IA, guardar el estado |
| Backend privado | FastAPI + SQLite | Token personal `X-AURUM-KEY` | Cartera real, órdenes, agentes |

El propietario emite un token de backend por persona con `POST /admin/tokens`, y cada usuario lo pega en Ajustes. Los tokens llevan rol (`owner`/`user`) y ámbitos (`read`, `execute`, `admin`), y se revocan de uno en uno.

## Qué cambió en esta iteración

### Edge (Cloudflare Pages)

- `functions/api/_middleware.ts`: **ninguna ruta de /api responde sin pasar por aquí**. Valida sesión, cierra CORS a una allowlist (antes era `*`), bloquea CSRF por origen, aplica límites por usuario y registra en auditoría.
- Auth por contraseña (`PBKDF2-SHA256`, 100.000 iteraciones) y Google OAuth (código + PKCE, `state` firmado en cookie httpOnly).
- Los proxies de IA exigen sesión, validan el modelo contra una allowlist y topan `max_tokens`. El consumo se registra por usuario en `ai_usage`.
- `/api/state`: estado por usuario en D1 con versión optimista y cuotas (256 KB por clave, 4 MB y 64 claves por usuario).

### Frontend

- `src/Root.tsx` decide entre pantalla de acceso y aplicación, e hidrata el estado antes de montar AURUM.
- `src/store/state.ts` sustituye a `localStorage` como fuente de verdad: caché en memoria para las lecturas síncronas de `src/nexus`, espejo local namespaceado por usuario para funcionar sin conexión, y sincronización con reintento.
- Migración automática y única de los datos del modo de un solo usuario, solo para claves que el usuario aún no tiene en el servidor.

### Backend privado

- La clave única compartida ya no es credencial de uso: solo emite el primer token de propietario.
- `backend/db.py` (SQLite): tokens, credenciales cifradas, órdenes y auditoría dejan de vivir en memoria.
- Credenciales de broker **por usuario**, cifradas con AES-256-GCM y atadas al correo del dueño (el criptograma de una persona no se descifra con el correo de otra).
- `backend/broker_sessions.py`: una sesión de Trade Republic por usuario, con su propio OTP.
- Órdenes: interruptor maestro, doble confirmación, idempotencia y límite diario acumulado.

## Estado verificado

- `npm run build` pasa.
- `npx tsc -p functions/tsconfig.json` pasa (las Functions ahora se comprueban de tipos, antes no).
- `python -m py_compile` pasa en todos los módulos del backend.
- Probado en `wrangler pages dev` con D1 local: alta del propietario, entrada en la app, emisión de invitación y persistencia del perfil en `user_state`.
- Probado con `curl`: 401 sin sesión en IA/mercado/estado, 403 en preflight desde origen ajeno, 403 en escritura con cookie desde origen ajeno, 400 con modelo fuera de la allowlist, 429 al superar el límite de login.
- Probado con `TestClient`: bootstrap del primer token y caducidad de la clave heredada, separación de roles y ámbitos, cifrado en reposo, doble confirmación de un solo uso, límite diario e idempotencia.
- **Sigue sin haber suite de pruebas automatizada**: todo lo anterior son comprobaciones manuales reproducibles, no tests en CI.

## Riesgos pendientes

1. **Ejecución de órdenes desactivada por diseño.** `AURUM_TRADING_ENABLED=false`. Antes de activarla conviene probar el flujo `prepare → invest` de principio a fin con importes mínimos.
2. **Sin verificación de correo.** La invitación es lo que acredita el alta; `email_verified` solo se marca cuando lo confirma Google. Falta recuperación de contraseña.
3. **Coste de PBKDF2.** 100.000 iteraciones es un compromiso por el límite de CPU del plan gratuito de Pages. Con plan de pago, subir `PBKDF2_ITERATIONS`: los hashes antiguos se regeneran solos en el siguiente login.
4. **Conflictos de estado.** Si dos dispositivos editan la misma clave a la vez, gana el último que escribe. Evita perder lo recién introducido, pero puede pisar un cambio simultáneo.
5. **Límites en D1.** Los contadores de rate limiting están en D1 por simplicidad. Si esto se abre al público, es lo primero que hay que mover a KV o al Rate Limiting nativo.
6. **Computer Agent.** Sigue pudiendo interactuar con webs arbitrarias. Mantener experimental y sin ejecución financiera automática.
7. **Cola del agente y estado de automatización** siguen en memoria en el backend.

## Puesta en marcha

```bash
# 1. Crear la base de datos y pegar el id en wrangler.toml
npx wrangler d1 create aurum
npx wrangler d1 migrations apply aurum --remote

# 2. Secretos del proyecto de Pages
npx wrangler pages secret put AURUM_SIGNING_SECRET
npx wrangler pages secret put AURUM_BOOTSTRAP_SECRET
npx wrangler pages secret put ANTHROPIC_API_KEY
# y AURUM_ALLOWED_ORIGINS / AURUM_PUBLIC_URL como variables

# 3. Backend: copiar backend/.env.example a .env y rellenar
#    AURUM_SECRET_KEY, AURUM_OWNER_EMAIL, AURUM_TRADING_ENABLED
```

Desarrollo local con Functions y D1:

```bash
npm run build && npx wrangler d1 migrations apply aurum --local && npx wrangler pages dev dist --port 8788
```

`vite dev` por sí solo no ejecuta las Functions, así que no hay sesión ni estado.

## Archivos clave

| Área | Ruta |
| --- | --- |
| Raíz y sesión del frontend | `src/Root.tsx` |
| Pantalla de acceso | `src/components/Login.tsx` |
| Estado del usuario | `src/store/state.ts` |
| Aplicación principal | `src/App.tsx` |
| Orquestación de IA | `src/nexus/` |
| Middleware del edge | `functions/api/_middleware.ts` |
| Auth del edge | `functions/api/auth/`, `functions/_lib/auth.ts` |
| Esquema D1 | `db/migrations/` |
| Backend FastAPI | `backend/main.py` |
| Identidad del backend | `backend/db.py`, `backend/security.py`, `backend/endpoints_identity.py` |
| Sesiones de broker | `backend/broker_sessions.py` |

## Variables de entorno

**Cloudflare Pages:** `AURUM_SIGNING_SECRET` (obligatoria), `AURUM_BOOTSTRAP_SECRET`, `AURUM_ALLOWED_ORIGINS`, `AURUM_PUBLIC_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

**Backend:** ver `backend/.env.example`. Las nuevas son `AURUM_SECRET_KEY`, `AURUM_OWNER_EMAIL`, `AURUM_DB_PATH`, `AURUM_TRADING_ENABLED` y `AURUM_MAX_DAILY_EUR`.

**Frontend local:** las variables `VITE_*` son solo para desarrollo y no deben usarse en un build publicado.
