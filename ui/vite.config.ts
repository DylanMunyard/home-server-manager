import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5780,
    proxy: {
      '/api': 'http://127.0.0.1:5781',
      '/ws': { target: 'http://127.0.0.1:5781', ws: true, changeOrigin: true },
    },
  },
});
