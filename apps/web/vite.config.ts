import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// WEB_PORT and API_TARGET let a private test stack run beside the owner's dev servers.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    proxy: { '/api': process.env.API_TARGET || 'http://127.0.0.1:3001' },
  },
});
