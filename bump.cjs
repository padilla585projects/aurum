#!/usr/bin/env node
/**
 * bump.js — incrementa la versión patch y la propaga a:
 *   package.json · android/app/build.gradle · src/App.tsx · public/latest.json
 *
 * Uso: node bump.js           → sube patch (1.2.0 → 1.2.1)
 *      node bump.js minor     → sube minor (1.2.0 → 1.3.0)
 *      node bump.js major     → sube major (1.2.0 → 2.0.0)
 */

const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;

// ── 1. Leer versión actual ────────────────────────────────────
const pkgPath = path.join(ROOT, 'package.json');
const pkg     = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// Si package.json tiene versión vieja (0.1.0) usamos la de App.tsx como base
const appContent = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
const appMatch   = appContent.match(/const APP_VERSION\s*=\s*'([\d.]+)'/);
const currentVer = appMatch ? appMatch[1] : pkg.version;

let [major, minor, patch] = currentVer.split('.').map(Number);

const bump = process.argv[2] || 'patch';
if      (bump === 'major') { major++; minor = 0; patch = 0; }
else if (bump === 'minor') { minor++; patch = 0; }
else                       { patch++; }

const newVersion = `${major}.${minor}.${patch}`;
const newCode    = major * 10000 + minor * 100 + patch;  // e.g. 1.2.1 → 10201
const today      = new Date().toISOString().slice(0, 10).replace(/-/g, '.');

console.log(`\n  ${currentVer} → ${newVersion}  (versionCode ${newCode})  build ${today}\n`);

// ── 2. package.json ──────────────────────────────────────────
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('  ✓ package.json');

// ── 3. android/app/build.gradle ──────────────────────────────
const gradlePath = path.join(ROOT, 'android/app/build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
gradle = gradle
  .replace(/versionCode\s+\d+/,       `versionCode ${newCode}`)
  .replace(/versionName\s+"[\d.]+"/,  `versionName "${newVersion}"`);
fs.writeFileSync(gradlePath, gradle, 'utf8');
console.log('  ✓ android/app/build.gradle');

// ── 4. src/App.tsx ───────────────────────────────────────────
let app = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
app = app
  .replace(/const APP_VERSION\s*=\s*'[\d.]+'/, `const APP_VERSION = '${newVersion}'`)
  .replace(/const APP_BUILD\s*=\s*'[\d.]+'/, `const APP_BUILD   = '${today}'`);
fs.writeFileSync(path.join(ROOT, 'src/App.tsx'), app, 'utf8');
console.log('  ✓ src/App.tsx');

// ── 5. public/latest.json ────────────────────────────────────
const latestPath = path.join(ROOT, 'public/latest.json');
const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
latest.version = newVersion;
latest.build   = today;
// El apkUrl se actualiza en release.bat después de subir a Drive
fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2) + '\n', 'utf8');
console.log('  ✓ public/latest.json');

console.log(`\n  Nueva versión: v${newVersion}\n`);
