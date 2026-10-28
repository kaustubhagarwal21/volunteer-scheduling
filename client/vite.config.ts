import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The API runs separately on :3000 in development. Proxying /api keeps the browser on a single
    // origin, exactly like production, so the session cookie behaves the same in both.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
