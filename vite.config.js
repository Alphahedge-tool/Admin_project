import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Trade Panel's Angel Node backend (option chain + basket + live feed).
      // Only /api/angel is proxied; the PHP admin API is called via its own
      // absolute URL, so it is unaffected.
      '/api/angel': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
