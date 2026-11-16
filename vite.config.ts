import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Relative assets make the production build portable between root and
  // subpath deployments (e.g. Caddy /sunlight/). Vite dev keeps root.
  base: process.env.VITE_BASE || (command === 'build' ? './' : '/'),
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
}));
