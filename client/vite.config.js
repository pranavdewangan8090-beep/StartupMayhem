import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // so it's reachable on the venue WiFi from phones during dev, not just localhost
    port: 5173,
    proxy: {
      // during local dev, forward API calls to the Express server so cookies
      // stay same-site (no CORS headaches while iterating)
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
