import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Single web build. Wrap the built dist/ with Capacitor (see README) to ship
// the same codebase as an iOS/Android app - no UI code fork needed.
export default defineConfig({
  plugins: [react()],
  // allowedHosts: true lets a phone reach the dev server through a tunnel / custom hostname; target keeps older iPhone Safari working
  // /api is forwarded to the back end (Spring Boot on :8080, or backend/contract-server) so the browser sees one origin: no CORS needed in development
  server: { host: true, port: 5173, allowedHosts: true, proxy: { '/api': { target: process.env.VITE_PROXY_TARGET || 'http://localhost:8080', changeOrigin: true } } },
  preview: { host: true, port: 4173, allowedHosts: true },
  esbuild: { target: 'safari13' },
  build: { target: 'safari13' },
});
