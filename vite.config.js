import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',   // Allow access from other machines
    port: 5173,        // Your Vite port

    proxy: {
      // Trade Panel's Node backend (option chain + basket + live feed + Zerodha).
      // Only /api/angel, /api/kotak and /api/zerodha are proxied; every other
      // /api path is the PHP admin API on Apache, so it is unaffected.
      '/api/angel': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },

      // Kotak Neo's headless auto-login lives in the same Node backend.
      '/api/kotak': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },

      // Zerodha login still needs a browser redirect, but the token exchange
      // runs through the same Node backend.
      '/api/zerodha': {
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