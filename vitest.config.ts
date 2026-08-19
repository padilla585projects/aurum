/**
 * Configuración de las pruebas del edge.
 *
 * Se usa el pool de Workers en lugar de jsdom o node: las Pages Functions
 * dependen de WebCrypto, de la clase Request de workerd y de D1, y emular esas
 * tres cosas a mano produciría pruebas que pasan contra el emulador y fallan
 * contra Cloudflare. Aquí el código corre en el mismo runtime que en producción
 * y contra una D1 real de Miniflare.
 *
 * Las migraciones se leen aquí (en Node) y se inyectan como binding, porque
 * dentro del worker no hay sistema de ficheros. Se aplican en setup.ts.
 */

import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

const migrations = await readD1Migrations('./db/migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2024-11-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Valores de prueba: ninguno coincide con los secretos reales.
          AURUM_SIGNING_SECRET: 'clave-de-firma-solo-para-pruebas',
          AURUM_BOOTSTRAP_SECRET: 'secreto-de-arranque-de-prueba',
          AURUM_ALLOWED_ORIGINS: 'https://aurum.test,https://otra.aurum.test',
          AURUM_PUBLIC_URL: 'https://aurum.test',
        },
      },
    }),
  ],
  test: {
    include: ['test/edge/**/*.test.ts'],
    setupFiles: ['./test/edge/setup.ts'],
  },
});
