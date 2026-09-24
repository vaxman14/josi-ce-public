import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  build: {
    outDir: 'dist',
    // No sourcemaps in the shipped bundle: they are a copy of the source, and
    // CE images go to strangers' machines.
    sourcemap: false,
    rollupOptions: {
      // Rolldown (Vite 8) accepts the function form. Keep React and its router
      // in one stable vendor chunk without relying on the removed object form.
      output: {
        manualChunks(id) {
          return /node_modules\/(?:react|react-dom|react-router|react-router-dom)\//.test(id)
            ? 'react'
            : undefined;
        },
      },
    },
  },
  // Dev only. In production the API serves this bundle from its own origin, so
  // the session cookie and the CSRF pair work without any cross-origin rules.
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
});
