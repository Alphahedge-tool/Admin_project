import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Trade Panel's Angel Node backend (option chain + basket + live feed).
      // Only /api/angel and /api/kotak are proxied; every other /api path is the
      // PHP admin API on Apache, so it is unaffected.
      '/api/angel': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Kotak Neo's headless auto-login lives in the same Node backend.
      '/api/kotak': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost',
        changeOrigin: true,
      },
    },
  },
})
