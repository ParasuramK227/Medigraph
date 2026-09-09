import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      // Cross-origin isolation is required for the threaded Moonshine WASM build
      // (SharedArrayBuffer). The matching prod headers live in render.yaml.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      // Proxy API calls to the Flask backend during dev to avoid CORS friction.
      '/api': {
        target: process.env.VITE_API_BASE || 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
})
