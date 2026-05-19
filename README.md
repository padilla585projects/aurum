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
