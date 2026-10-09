import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  /*
    A dev-only proxy, and the only configuration in this file that is not part of the
    build. Off unless `VITE_API_PROXY` names an origin, so `npm run build` is
    unaffected.

    It exists because `dev-api.mjs` serves the serverless function on :3000 while
    `vite` serves the client on :5173, and a browser will not let the second call
    the first without CORS headers that the function has no reason to send. With
    this set, the client keeps using same-origin `/api/...` exactly as it does in
    production, and Vite forwards it — so what you inspect locally is the same code
    path that ships.

        node dev-api.mjs
        $env:VITE_API_PROXY="http://localhost:3000"; npm run dev
  */
  server: process.env.VITE_API_PROXY
    ? { proxy: { '/api': process.env.VITE_API_PROXY } }
    : undefined,
})