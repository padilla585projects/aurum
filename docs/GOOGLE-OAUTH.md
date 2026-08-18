# Acceso con Google

Guía para activar el acceso con Google en AURUM, en web y en la APK.

Mientras falten `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`, `/api/auth/config` devuelve `googleEnabled: false`, la pantalla de acceso no ofrece el botón y `/api/auth/google/start` responde 503. Solo funciona la contraseña.

## Un solo cliente para web y APK

Solo hace falta **un cliente OAuth de tipo aplicación web**. La APK no habla con Google: abre el navegador del sistema contra el mismo `/api/auth/google/start` del despliegue, y Google redirige a la misma URI de callback. El servidor es un cliente confidencial y el `client_secret` nunca sale del edge.

Esto es deliberado. Un cliente OAuth nativo obligaría a incrustar credenciales en el APK, donde cualquiera puede extraerlas.

## 1. Crear el cliente en Google Cloud

En [console.cloud.google.com](https://console.cloud.google.com), con el proyecto que quieras usar:

1. **APIs y servicios → Pantalla de consentimiento de OAuth**
   - Tipo de usuario: **Externo**.
   - Rellena nombre de la aplicación, correo de asistencia y correo de contacto.
   - Ámbitos: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. No hace falta ninguno más — AURUM solo usa Google para identificar, no para leer datos.
   - **Déjala en modo «Prueba»** y añade como usuarios de prueba los correos que vayan a entrar. Mientras el despliegue sea privado, esto es una barrera adicional: aunque alguien tuviera una invitación, Google no le dejaría completar el flujo si no está en la lista.

2. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**
   - Tipo de aplicación: **Aplicación web**.
   - Orígenes de JavaScript autorizados:
     ```
     https://aurum-7cm.pages.dev
     ```
   - URI de redirección autorizados:
     ```
     https://aurum-7cm.pages.dev/api/auth/google/callback
     ```
   - Anota el **ID de cliente** y el **secreto de cliente**.

La URI de redirección tiene que coincidir carácter a carácter con la que construye `redirectUri()` en [functions/api/auth/google/start.ts](../functions/api/auth/google/start.ts), que sale de `AURUM_PUBLIC_URL`. Si cambias el dominio, hay que actualizar las dos cosas.

## 2. Cargar las credenciales en Cloudflare

```bash
npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name aurum
npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name aurum
```

Y lo mismo para las vistas previas, si quieres probarlas ahí:

```bash
npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name aurum --env preview
npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name aurum --env preview
```

## 3. Redesplegar

**Este paso no es opcional.** Cloudflare Pages fija las variables en el momento de crear cada despliegue: uno ya existente no ve un secreto añadido después.

```bash
npm run deploy
```

Comprueba que ha entrado:

```bash
curl -s https://aurum-7cm.pages.dev/api/auth/config
# googleEnabled debe ser true
```

## Cómo funciona cada plataforma

**Web** — el botón lleva a `/api/auth/google/start`. El `state` y el verificador PKCE viajan en una cookie httpOnly firmada, no en la URL. Al volver, el callback crea la sesión y la entrega como cookie httpOnly.

**APK** — el botón abre el navegador del sistema con `?client=native` (Google rechaza OAuth dentro de un webview embebido con `disallowed_useragent`). El callback detecta el flujo nativo y redirige a `aurum://auth?auth=ok&code=…`.

Por el deep link **no viaja la sesión**, solo un código de un solo uso con dos minutos de vida: en Android cualquier aplicación puede registrar el mismo esquema y recibir esa URL. La app canjea el código en `POST /api/auth/exchange`, y solo en esa petición se crea la sesión y se entrega el token.

El esquema está declarado en tres sitios que deben coincidir:

| Qué | Dónde |
| --- | --- |
| `NATIVE_SCHEME = 'aurum://auth'` | [functions/api/auth/google/callback.ts](../functions/api/auth/google/callback.ts) |
| `DEEP_LINK_PREFIX` | [src/store/native-auth.ts](../src/store/native-auth.ts) |
| `<data android:scheme="aurum" android:host="auth" />` | `android/app/src/main/AndroidManifest.xml` |

> **Ojo:** `android/` está en `.gitignore`, así que el `intent-filter` del manifiesto **no está versionado**. Si regeneras el proyecto Android desde cero, hay que volver a añadirlo o el deep link no funcionará.

## Vincular una cuenta que ya existe

Si el correo de Google coincide con una cuenta de AURUM ya creada, se vinculan **solo si Google confirma que el correo está verificado**. Sin eso el flujo se rechaza con `email_unverified`: de lo contrario, cualquiera que registrase un correo ajeno en su cuenta de Google podría apropiarse de una cuenta.

Crear una cuenta nueva por Google sigue exigiendo invitación, igual que por contraseña.
