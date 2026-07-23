import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Where the Node backend actually landed. `npm run dev` steps onto the next free
// port when 3001 belongs to something else (see scripts/dev.mjs) and passes the
// one it settled on down in VITE_BACKEND_PORT, so these proxies follow it. The
// VITE_ prefix is what also lets browser code read it off import.meta.env - the
// Zerodha callback page is served from the backend's own origin, and the listener
// that receives its postMessage has to expect the same port. Running `vite` on its
// own has no such parent and falls back to the default.
const backendTarget = `http://localhost:${Number(process.env.VITE_BACKEND_PORT) || 3001}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    host: '0.0.0.0',   // Allow access from other machines
    port: 5173,        // Your Vite port

    proxy: {
      // Trade Panel's Node backend (option chain + basket + live feed + Zerodha).
      // Only /api/angel, /api/kotak and /api/zerodha are proxied; every other
      // /api path is the PHP admin API on Apache, so it is unaffected.
      '/api/angel': {
        target: backendTarget,
        changeOrigin: true,
      },

      // Kotak Neo's headless auto-login lives in the same Node backend.
      '/api/kotak': {
        target: backendTarget,
        changeOrigin: true,
      },

      // Zerodha login still needs a browser redirect, but the token exchange
      // runs through the same Node backend.
      '/api/zerodha': {
        target: backendTarget,
        changeOrigin: true,
      },

      '/api': {
        target: 'http://localhost',
        changeOrigin: true,
      },
    },
  },
})
