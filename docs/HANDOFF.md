# Continuidad del proyecto AURUM

Actualizado: 2026-08-18

## Qué es

AURUM es una aplicación personal de asesoramiento y seguimiento de inversiones. Combina una SPA React/PWA, proxies de IA en Cloudflare Pages y un backend FastAPI privado para integración con Trade Republic, automatización y Telegram.

## Estado validado

- `npm run build` pasa correctamente.
- `python -m py_compile backend/main.py backend/local_agent.py backend/computer_agent.py` pasa correctamente.
- `npm audit --omit=dev` no reportó vulnerabilidades conocidas durante la auditoría inicial.
- No hay suite automatizada de pruebas todavía.

## Cambios de seguridad recientes

- El backend usa `AURUM_ALLOWED_ORIGINS` para CORS; el valor de ejemplo autoriza el dominio de Pages y Vite local.
- Las órdenes tienen validación de campos e importes; el máximo duro es 10.000 EUR por orden o configuración.
- Los planes autónomos de IA se validan con el mismo modelo que las órdenes de API y no pueden exceder el presupuesto del ciclo.
- El agente local rechaza comandos shell y solo acepta screenshot, apertura de aplicaciones autorizadas, puntero, teclado, URL y scroll.
- Las credenciales de `ComputerAgent` no se añaden a prompts ni al historial enviado al proveedor de IA.

## Riesgos pendientes (antes de exponer o escalar)

1. Las Functions de Cloudflare que proxyfían los proveedores de IA siguen sin autenticación ni rate limiting. No publicar la URL para terceros hasta resolverlo.
2. `AURUM_API_KEY` se conserva en `localStorage` para acceder al backend. Cambiar a sesiones de corta duración y roles separados para lectura y ejecución.
3. Las operaciones de compra/venta no tienen idempotencia, límite diario, registro persistente ni workflow de doble confirmación.
4. El Computer Agent puede interactuar con webs arbitrarias. Mantenerlo experimental y bloquear ejecución financiera automática hasta diseñar una allowlist de dominios y confirmación humana fuera de banda.
5. El estado de automatización, cola del agente y logs reside en memoria. Se pierde al reiniciar y no es seguro para múltiples instancias.

## Próximo hito recomendado

Decidir el modelo de acceso:

- **Uso personal privado:** proteger Functions con Cloudflare Access y mantener backend únicamente a través de Tailscale.
- **Producto multiusuario:** implementar identidad de usuarios, sesiones, almacenamiento seguro de secretos, límites por usuario, observabilidad y auditoría persistente antes de permitir operaciones.

Tras esa decisión, implementar autenticación/rate limiting en `functions/api/`, extraer `src/App.tsx` en módulos y añadir pruebas de API para límites de órdenes y flujos de automatización.

## Archivos clave

| Área | Ruta |
| --- | --- |
| Aplicación principal | `src/App.tsx` |
| Orquestación de IA | `src/nexus/` |
| Proxies Cloudflare | `functions/api/` |
| Backend FastAPI | `backend/main.py` |
| Broker Trade Republic | `backend/tr_client.py` |
| Agente de navegador | `backend/computer_agent.py` |
| Agente de escritorio | `backend/local_agent.py` |

## Variables de entorno

Frontend local: las variables `VITE_ANTHROPIC_API_KEY`, `VITE_OPENAI_API_KEY` y `VITE_DEEPSEEK_API_KEY` son solo para desarrollo y no deben usarse en un build publicado.

Cloudflare Pages: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` y/o `DEEPSEEK_API_KEY` según los proveedores activados.

Backend: usar `backend/.env.example` como plantilla. Las variables principales son `AURUM_API_KEY`, `AURUM_ALLOWED_ORIGINS`, `ANTHROPIC_API_KEY`, `TR_PHONE`, `TR_PIN`, `TELEGRAM_TOKEN` y `TELEGRAM_CHAT_ID`.
