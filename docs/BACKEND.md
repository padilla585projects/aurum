# Conectar AURUM con tu broker

> **Si solo quieres el asesor, no necesitas nada de este documento.** Abre la aplicación, pon tu clave de IA en Ajustes y ya está: chat con los agentes, Research, análisis y simulador funcionan sin instalar nada.

Esto es para una cosa concreta: que AURUM **vea tu cartera real de Trade Republic** en lugar de que la escribas tú. Mucha gente prefiere llevarla a mano, y es una opción perfectamente válida — no pierdes ningún consejo por ello, solo escribes tus posiciones una vez.

| | Sin backend | Con backend |
| --- | --- | --- |
| Chat, Research, simulador | Sí | Sí |
| Cartera | La escribes tú | Se lee sola de Trade Republic |
| Comprar y vender | No | Solo si lo activas a mano |
| Agente que maneja el PC | No | Sí |

## Por qué hace falta un programa aparte

Trade Republic no tiene una API pública. La única forma de leer tu cartera es hablar con la misma interfaz que usa su aplicación móvil, y para eso hay que darle tu teléfono y tu PIN.

Eso no puede vivir en la nube: significaría que tus credenciales de banca están en un servidor de otra persona. Así que va en un programa pequeño —el *backend*— que **corre en tu ordenador**, guarda tus credenciales cifradas ahí y no las manda a ninguna parte.

> **Cada usuario tiene el suyo.** No es un servidor compartido: si sois varios usando AURUM, cada uno instala el suyo en su máquina, con sus claves. Nadie puede leer las credenciales de otro, porque no están en el mismo sitio.

## 1. Instalarlo

### Si tienes Proxmox *(lo más fácil, y lo que recomiendo)*

Una línea en la consola del **host** de Proxmox, como root. No hace falta descargar nada antes:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/padilla585projects/aurum/main/deploy-proxmox.sh)"
```

Te pregunta cuatro cosas —todas con respuesta por defecto, puedes darle a intro— y hace el resto: crea el contenedor, instala el backend, lo deja arrancando solo y, si le dices que sí, conecta Tailscale y lo publica por https para que funcione desde el móvil.

Ventaja de esta vía: el contenedor está siempre encendido, así que el backend no depende de que tu ordenador lo esté.

Si algo falla a mitad, deshace el contenedor que acababa de crear; no te deja restos que limpiar. Y si te levantas mientras espera a que autorices Tailscale, no pasa nada: deja hecho un mandato que lo termina.

### En tu propio ordenador

Descarga el proyecto y ejecuta, dentro de la carpeta `backend`:

**Windows**

```bash
powershell -ExecutionPolicy Bypass -File instalar.ps1
```

**Linux o macOS**

```bash
bash instalar.sh
```

El instalador comprueba Python, prepara un entorno aislado, instala lo necesario, genera tus claves, arranca el servicio y te da al final **dos datos**: la dirección y tu token. Son los que hay que pegar en la aplicación.

El token se muestra **una sola vez**. Si lo pierdes, borra `backend/aurum.db` y vuelve a ejecutar el instalador.

### El token de la aplicación es de solo lectura

El instalador emite en realidad **dos** tokens, y la diferencia importa:

| Token | Qué permite | Dónde acaba |
| --- | --- | --- |
| **Solo lectura** | Ver tu cartera y sus precios, y enlazar Trade Republic | Es el que te muestra al final y el que pegas en la aplicación |
| **Administración** | Además: mandar órdenes, programar tareas y manejar el agente que controla el PC | Se queda en `backend/.env`, como `AURUM_ADMIN_TOKEN`. No se pega en ningún sitio |

La razón es que ese token **el navegador lo ve**. Tiene que verlo: es la propia página la que llama a tu backend, así que la clave viaja hasta ella y cualquiera con la consola abierta en tu sesión puede leerla. Si lo que puede hacer se limita a leer, lo que se pierde si se escapa se limita a leer.

Que existan los dos también es lo que deja la puerta abierta: la clave de arranque (`AURUM_API_KEY`) solo funciona **mientras no hay ningún token**. Sin el de administración guardado no habría forma de emitir ninguno más.

### Si de verdad quieres que la aplicación pueda operar

Emite un token con más alcance usando el de administración, dentro de la carpeta `backend`:

```bash
curl -s -X POST http://127.0.0.1:8000/admin/tokens -H "X-AURUM-KEY: $(grep '^AURUM_ADMIN_TOKEN=' .env | cut -d= -f2-)" -H 'Content-Type: application/json' -d '{"user_email":"TU@CORREO.COM","role":"owner","scopes":["read","execute","admin"],"label":"aplicacion-completa"}'
```

Pega el `token` que devuelva en Ajustes, en lugar del anterior. Piénsalo antes: a partir de ahí, ese token está en el navegador y puede mover dinero.

## 2. Conectarlo con la aplicación

En AURUM: **Ajustes → Backend**. Pega la dirección y el token, y pulsa *Probar conexión*.

Qué dirección poner depende de dónde uses AURUM:

| Usas AURUM en… | Dirección | Hace falta algo más |
| --- | --- | --- |
| El mismo ordenador donde instalaste el backend | `http://localhost:8000` | No |
| El móvil, o cualquier otro dispositivo | Una dirección `https://…` | Sí, ver abajo |

### Por qué desde el móvil no vale `http://192.168.…`

AURUM se sirve por **https**. Los navegadores bloquean que una página https pida datos a una dirección `http://` — se llama *contenido mixto*, y existe para que nadie pueda espiar o alterar esas peticiones.

`http://localhost` es la única excepción: el navegador sabe que no sale de tu propia máquina, así que lo permite. Por eso desde el mismo ordenador funciona sin más, y desde el móvil no.

Para el móvil necesitas que tu backend tenga una dirección **https**. Dos formas:

**Tailscale** *(recomendada)* — una red privada entre tus dispositivos. El backend nunca queda expuesto a internet.

1. Instala [Tailscale](https://tailscale.com/download) en el ordenador y en el móvil, con la misma cuenta.
2. En el ordenador, ejecuta:
   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:8000
   ```
3. Te dará una dirección tipo `https://tu-equipo.tured.ts.net`. Esa es la que pegas en Ajustes.

Para desactivarlo más tarde: `tailscale serve --https=443 off`.

**Túnel de Cloudflare** — más rápido de montar, pero deja el backend accesible desde internet, protegido solo por tu token. Si eliges esta vía, trata ese token como una contraseña.

## 3. Conectar Trade Republic

Con el backend ya conectado, en la misma pantalla de Ajustes introduce el **teléfono y el PIN** de tu cuenta de Trade Republic.

TR mandará un **código por SMS a tu móvil**. Introdúcelo para completar el acceso. Ese paso no se puede automatizar y es deliberado: es lo que impide que nadie entre en tu cuenta solo con haberte robado un fichero.

Tus credenciales se guardan **cifradas** con la clave que generó el instalador, y solo en tu máquina.

## 4. Comprar y vender está desactivado

De fábrica, `AURUM_TRADING_ENABLED=false`. AURUM puede leer tu cartera, analizarla y proponerte operaciones, pero **no manda ninguna orden al broker**.

Para activarlo hay que editar `backend/.env` a mano. Antes de hacerlo, conviene entender qué controles hay:

- **Doble confirmación**: cada orden se prepara primero y se ejecuta después con un vale de un solo uso. Si el plan cambia entre medias, se rechaza.
- **Clave de idempotencia**: reenviar la misma orden no la ejecuta dos veces.
- **Límite diario** acumulado, además del tope por orden.

Aun así, es dinero real. Pruébalo primero con importes mínimos.

## Si algo no funciona

| Lo que ves | Qué pasa |
| --- | --- |
| «No se ha podido conectar» y usas una dirección `http://` desde el móvil | Contenido mixto: necesitas https. Ver el apartado 2. |
| «No se ha podido conectar» desde el mismo ordenador | El backend no está arrancado. Vuelve a ejecutar el instalador. |
| «Token inválido o revocado» | El token no es el que corresponde a ese backend. Si lo perdiste, borra `backend/aurum.db` y reinstala. |
| «Ese token no tiene permiso para esta operación» | Estás usando el de solo lectura en algo que escribe. Es lo esperado; ver el apartado 1. |
| «No autenticado en Trade Republic» | Falta completar el paso 3, o la sesión ha caducado. Vuelve a introducir el código. |
| El backend deja de responder al apagar el PC | Es lo normal: corre en tu máquina. Si lo quieres siempre disponible, instálalo en un equipo que esté siempre encendido — con Proxmox, la vía del apartado 1. |
| Tailscale se quedó sin autorizar | Ejecuta `sh /root/aurum-tailscale-<id>.sh` en el host de Proxmox: autoriza, publica por https y te dice la dirección. |
| «No se ha podido publicar por https» | Falta activar los certificados: entra en login.tailscale.com → DNS y enciende *HTTPS Certificates*. Luego repite el mandato anterior. |

## Qué guarda, y dónde

Todo vive en `backend/`, en tu máquina:

| Fichero | Contiene |
| --- | --- |
| `.env` | Tus claves, incluido el token de administración. No lo compartas ni lo subas a ningún sitio. |
| `aurum.db` | Tokens de acceso, credenciales de broker cifradas, historial de órdenes y auditoría. |
| `aurum-backend.log` | Registro de arranque, útil si algo falla. |

Ninguno de los tres sale de tu ordenador.
