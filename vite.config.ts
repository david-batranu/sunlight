import { defineConfig } from 'vite';

export default defineConfig({
  // The deployment behind Caddy can be mounted on a subpath (e.g. /sunlight/).
  base: process.env.VITE_BASE || '/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: false
      }
    }
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 900
  }
});
