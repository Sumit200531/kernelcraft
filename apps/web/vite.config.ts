import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'single' ? './' : (process.env.KC_BASE ?? '/'),
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.KC_API ?? 'http://127.0.0.1:8787', changeOrigin: true } }
  },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 1200
  }
}));
