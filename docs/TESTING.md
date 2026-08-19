# Pruebas de AURUM

Actualizado: 2026-08-19

Dos suites, una por cada mitad del sistema. Ninguna necesita red, credenciales
reales ni la base de datos de producción.

```bash
npm test              # edge: Pages Functions, dentro de workerd y con D1 real
npm run test:backend  # backend privado: FastAPI + SQLite
npm run check         # las dos, más el build y la comprobación de tipos
```

## Edge — Vitest sobre el pool de Workers

`vitest.config.ts` levanta las pruebas dentro de **workerd**, el mismo runtime
que ejecuta las Functions en Cloudflare, y les da una **D1 de Miniflare** de
verdad. No hay dobles de WebCrypto ni de D1: si una consulta viola una clave
ajena o un `crypto.subtle` no se comporta como en producción, la prueba falla
aquí y no después del despliegue.

Las migraciones de `db/migrations` se leen en Node (dentro del worker no hay
sistema de ficheros), se inyectan como binding y se aplican en
`test/edge/setup.ts`. Ese mismo fichero vacía las tablas antes de cada prueba,
de modo que una que cuenta usuarios —`needsBootstrap`— sigue diciendo la verdad
aunque otra haya creado cuentas.

### `dispatch`, la pieza que hace que esto valga algo

`test/edge/helpers.ts` reproduce el encadenado de Pages: primero
`functions/api/_middleware.ts` y, si llama a `next()`, el handler del fichero que
corresponde a la ruta. Probar los handlers sueltos no diría nada sobre las
cuatro garantías que de verdad protegen la aplicación —sesión, CORS, CSRF y
límites—, porque las cuatro viven en el middleware.

```ts
const { user, token } = await seedLoggedIn();
const res = await dispatch('/api/state', { method: 'PUT', bearer: token, body: { entries: [] } });
```

Opciones útiles de `dispatch`: `cookie` para simular el navegador y `bearer` para
la APK (la distinción importa: la protección CSRF solo aplica a la primera),
`origin` para probar la allowlist, y `envOverrides` para encender Google OAuth o
una clave de proveedor solo en una prueba.

Los usuarios se siembran con `seedUser`/`seedSession` en lugar de registrarlos
por la API: cada alta real cuesta una derivación PBKDF2 de 100.000 iteraciones y
la mayoría de las pruebas solo necesita que el usuario exista. Las que sí van
por la API son las de `auth.test.ts`, que es donde eso se está probando.

### Qué cubre

| Fichero | Qué fija |
| --- | --- |
| `crypto.test.ts` | Formato del hash, rechazo de esquemas y costes raros, regeneración al subir iteraciones, payloads firmados que no se pueden manipular ni estirar, PKCE |
| `http.test.ts` | Que **nunca** se emita `Access-Control-Allow-Origin: *`, comparación exacta de la allowlist, cookies, límites de cuerpo, validación de correo y contraseña |
| `ratelimit.test.ts` | Corte al superar el máximo, cubos independientes por sujeto y por ruta, y que un fallo de D1 deje pasar en vez de bloquear la aplicación |
| `middleware.test.ts` | 401 sin sesión, sesión caducada o suspendida, preflight, CSRF con cookie desde origen ajeno, 429, y 500 genérico sin filtrar el error |
| `auth.test.ts` | Bootstrap del owner y cierre de esa vía, invitaciones de un solo uso y atadas a un correo, respuestas indistinguibles en login, cierre de sesión, canje del código de la APK |
| `state.test.ts` | Aislamiento entre usuarios, conflicto de versión con 409, atomicidad del lote, cuotas por clave, por tamaño y por número de claves |
| `ai.test.ts` | Allowlist de modelos, tope de `max_tokens`, imputación del consumo por usuario, y `/api/market` |
| `google.test.ts` | Reglas de vinculación de cuentas, `state` firmado, invitación obligatoria para crear cuenta, y que en la APK el token **no** viaje en el deep link |

Las llamadas salientes (Anthropic, OpenAI, Yahoo, Google) se interceptan
sustituyendo `fetch` con `vi.stubGlobal`. Ninguna prueba sale a internet.

### Tipos

`functions/tsconfig.json` comprueba el código de producción; las pruebas no se
comprueban de tipos. Usan API específicas de workerd (`Response.json<T>()`,
`cloudflare:test`) que exigirían añadir `@cloudflare/workers-types` y retocar
firmas de `functions/_lib` solo para satisfacer al comprobador. El runtime de
Vitest las ejecuta igual, y un error de tipos en una prueba sale como prueba que
falla.

## Backend privado — pytest

`backend/tests/conftest.py` fija el entorno **antes** de importar nada de
`backend/`, porque tanto `AURUM_DB_PATH` como el interruptor
`AURUM_TRADING_ENABLED` se leen en el momento del import. Con eso la suite:

- usa una SQLite desechable en un directorio temporal, nunca `backend/aurum.db`;
- deja `TELEGRAM_TOKEN` y `ANTHROPIC_API_KEY` vacíos, así que no puede mandar un
  mensaje ni gastar tokens de verdad;
- crea el `TestClient` **sin** `with`, de modo que no se ejecuta el lifespan y no
  arrancan ni el planificador autónomo ni el bot de Telegram.

| Fichero | Qué fija |
| --- | --- |
| `test_security.py` | Que el criptograma de una persona no se descifre con el correo de otra, que sin `AURUM_SECRET_KEY` falle en lugar de guardar en claro, y la lista de ámbitos |
| `test_db.py` | Tokens guardados solo como hash, revocación y caducidad, credenciales cifradas en reposo, importe diario por usuario, confirmaciones de un solo uso |
| `test_identity_api.py` | Que la clave heredada solo emita el primer token de propietario y caduque después, separación de rol y ámbitos, y que el PIN no vuelva nunca en una respuesta |
| `test_orders.py` | Las cuatro guardas en orden: interruptor maestro, doble confirmación (incluido el cambio de plan entre pasos), idempotencia y límite diario |

Ninguna prueba de órdenes llega a tocar el broker: lo que se comprueba es
justamente que no se llegue si falta cualquiera de las cuatro guardas. Las que
las superan todas terminan en 401 al pedir la sesión de Trade Republic, y eso es
lo que se afirma.

## CI

`.github/workflows/tests.yml` ejecuta las dos suites en cada empujón a `main` y
en cada pull request, más el build del frontend, la comprobación de tipos de las
Functions y `compileall` del backend.

## Lo que sigue sin cubrirse

- El **frontend** (`src/`) no tiene pruebas: ni `src/store/state.ts` ni la
  migración de datos del modo de un solo usuario.
- La **ejecución real de una orden** contra Trade Republic, que por diseño está
  detrás de `AURUM_TRADING_ENABLED=false`.
- El **recorrido del deep link en un móvil real**: las pruebas llegan hasta el
  código de un solo uso y su canje, pero el `intent-filter` de Android no se
  puede ejercitar desde aquí.
- `telegram_bot.py`, `computer_agent.py` y `local_agent.py`.
