# AURUM — Prompt para Claude Code

Pega este prompt completo en Claude Code para que monte el proyecto desde cero.

---

## PROMPT

Quiero que crees un proyecto completo llamado **AURUM** — una aplicación web de asesor de inversión con IA.

### Lo que tienes que hacer:

1. **Crear la estructura del proyecto** con Vite + React + TypeScript:
```
aurum/
├── src/
│   ├── App.tsx              ← componente principal (ver código abajo)
│   ├── main.tsx
│   └── index.css
├── functions/
│   └── api/
│       └── chat.ts          ← Cloudflare Function (proxy seguro para Anthropic)
├── public/
│   ├── manifest.json        ← PWA manifest
│   └── icons/               ← iconos de la app
├── index.html
├── vite.config.ts
├── package.json
├── tsconfig.json
├── wrangler.toml            ← config Cloudflare Pages
├── capacitor.config.ts      ← config para APK Android
└── .env.example             ← variables de entorno de ejemplo
```

2. **Instalar dependencias**:
```bash
npm create vite@latest aurum -- --template react-ts
cd aurum
npm install recharts @capacitor/core @capacitor/cli @capacitor/android
npm install -D wrangler
```

3. **Crear el archivo `src/App.tsx`** con el siguiente código fuente exacto (es el componente React completo de AURUM v2):

```tsx
PEGAR_AQUI_EL_CODIGO_DE_App.tsx
```

> **NOTA:** El código fuente de `App.tsx` está en el archivo `aurum-v2.jsx` que tienes en la misma carpeta que este prompt. Cópialo íntegro como contenido de `src/App.tsx` cambiando la extensión a `.tsx`.

4. **Crear la Cloudflare Function** `functions/api/chat.ts`:
```typescript
interface Env {
  ANTHROPIC_API_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const body = await context.request.json();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": context.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};

export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
};
```

5. **Actualizar el fetch en `App.tsx`** para que llame al proxy en producción:
   - Busca la línea con `fetch("https://api.anthropic.com/v1/messages"` dentro de la función `callApi`
   - Reemplázala por:
```typescript
const API_URL = import.meta.env.DEV
  ? "https://api.anthropic.com/v1/messages"
  : "/api/chat";

// Y en los headers, en producción NO enviar x-api-key (lo pone el proxy)
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (import.meta.env.DEV) {
  headers["x-api-key"] = import.meta.env.VITE_ANTHROPIC_API_KEY || "";
  headers["anthropic-version"] = "2023-06-01";
}
```

6. **Crear `wrangler.toml`**:
```toml
name = "aurum"
compatibility_date = "2024-01-01"
pages_build_output_dir = "dist"
```

7. **Crear `capacitor.config.ts`** para el APK:
```typescript
import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aurum.advisor',
  appName: 'AURUM',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
```

8. **Crear `public/manifest.json`** para PWA:
```json
{
  "name": "AURUM — Investment Advisor",
  "short_name": "AURUM",
  "description": "Tu asesor de inversión personal con IA",
  "theme_color": "#c9a84c",
  "background_color": "#07070e",
  "display": "standalone",
  "start_url": "/",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

9. **Crear `.env.example`**:
```
VITE_ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
```

10. **Crear `README.md`** con instrucciones completas:

```markdown
# AURUM — Investment AI Advisor

Asesor de inversión personal con IA, 4 agentes especializados, tracker de cartera, research profundo y simulador.

## Stack
- React + Vite + TypeScript
- Recharts (gráficos)
- Cloudflare Pages (hosting)
- Cloudflare Functions (proxy seguro API)
- Capacitor (APK Android)

## Desarrollo local

1. Clona el repo y entra en la carpeta
2. Copia `.env.example` a `.env` y añade tu API key de Anthropic
3. Instala dependencias: `npm install`
4. Arranca en local: `npm run dev`

## Deploy en Cloudflare Pages

1. Sube el código a GitHub
2. Ve a Cloudflare Pages → Create project → conecta tu repo
3. Build command: `npm run build`
4. Build output: `dist`
5. En Settings → Environment variables → añade `ANTHROPIC_API_KEY`
6. Deploy

## Generar APK Android

1. Compila la app: `npm run build`
2. Inicializa Capacitor: `npx cap add android`
3. Sincroniza: `npx cap sync android`
4. Abre Android Studio: `npx cap open android`
5. En Android Studio: Build → Generate Signed Bundle/APK → APK
6. El APK estará en `android/app/build/outputs/apk/`

## Obtener API Key de Anthropic

1. Ve a https://console.anthropic.com
2. API Keys → Create Key
3. Copia la key (empieza por `sk-ant-`)
4. En local: pégala en `.env`
5. En Cloudflare: pégala en Environment Variables como `ANTHROPIC_API_KEY`
```

11. **Actualizar `package.json`** con los scripts necesarios:
```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "deploy": "npm run build && wrangler pages deploy dist",
    "android": "npm run build && npx cap sync android && npx cap open android"
  }
}
```

12. **Verificar que todo compila** ejecutando:
```bash
npm run build
```

Si hay errores de TypeScript en `App.tsx` por el JSX inline styles, añade al `tsconfig.json`:
```json
{
  "compilerOptions": {
    "strict": false,
    "jsx": "react-jsx"
  }
}
```

---

### Resultado esperado

Al terminar debe existir un proyecto que:
- `npm run dev` → arranca la app en localhost:5173
- `npm run build` → genera `dist/` listo para Cloudflare
- `npm run android` → abre Android Studio para generar el APK
- El proxy en `functions/api/chat.ts` oculta la API key en producción

---

### Notas importantes

- El archivo `aurum-v2.jsx` contiene el componente completo. Úsalo como `src/App.tsx`.
- En desarrollo local la app llama directamente a Anthropic (necesitas API key en `.env`).
- En producción (Cloudflare Pages) llama a `/api/chat` que es el proxy seguro.
- La API key NUNCA debe estar en el código del frontend ni en el repositorio de GitHub.
