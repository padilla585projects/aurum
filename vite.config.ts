import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Aumenta el límite de advertencia a 600 kB (la app es una SPA con todo incluido)
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Separa recharts del bundle principal para mejor caché de navegador
        manualChunks: {
          'vendor-react':    ['react', 'react-dom'],
          'vendor-recharts': ['recharts'],
        },
      },
    },
  },
})
