/**
 * Prepara la APK compilada para que el sitio la sirva.
 *
 * Copia el binario a `dist/descargas/` y deja a su lado un `version.json` con
 * la versión que declara el proyecto de Android. Ese fichero es lo que permite
 * que la aplicación del móvil sepa que hay una versión más nueva que la suya:
 * sin él, avisar de una actualización sería adivinar.
 *
 * Va a `dist/` y no a `public/` por un motivo que no se ve venir: lo que hay en
 * `public/` acaba en `dist/`, y `cap sync` copia `dist/` dentro de la APK — la
 * APK terminaba empaquetada dentro de si misma, doblando de tamaño en cada
 * version. Copiando despues de compilar, eso no puede pasar.
 *
 * El orden importa:
 *
 *   npm run build  →  npx cap sync android  →  gradlew assembleDebug
 *   →  node scripts/publicar-apk.mjs  →  wrangler pages deploy dist
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const destino = join(raiz, 'dist', 'descargas');
const compiladas = join(raiz, 'android', 'app', 'build', 'outputs', 'apk', 'debug');

function muere(mensaje) {
  console.error(`\n  ✕ ${mensaje}\n`);
  process.exit(1);
}

// ── Versión declarada en el proyecto de Android ────────────────────────────
const gradle = readFileSync(join(raiz, 'android', 'app', 'build.gradle'), 'utf8');
const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1];

if (!versionCode || !versionName) {
  muere('No encuentro versionCode/versionName en android/app/build.gradle');
}

// ── La APK más reciente de las compiladas ──────────────────────────────────
let apks = [];
try {
  apks = readdirSync(compiladas).filter(f => f.endsWith('.apk'));
} catch {
  muere('No hay APKs compiladas. Ejecuta primero:  cd android && ./gradlew assembleDebug');
}
if (apks.length === 0) muere('No hay ninguna APK en ' + compiladas);

// La más reciente, que es la que se acaba de compilar.
const apk = apks
  .map(f => ({ f, t: statSync(join(compiladas, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0].f;

mkdirSync(destino, { recursive: true });
copyFileSync(join(compiladas, apk), join(destino, 'aurum.apk'));

writeFileSync(
  join(destino, 'version.json'),
  JSON.stringify({ versionCode, versionName, apk }, null, 2) + '\n',
);

const mb = (statSync(join(destino, 'aurum.apk')).size / 1048576).toFixed(1);
console.log(`\n  ✓ ${apk}  →  dist/descargas/aurum.apk  (${mb} MB)`);
console.log(`    versión ${versionName} (${versionCode})\n`);
