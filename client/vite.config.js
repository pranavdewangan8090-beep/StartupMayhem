import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // so it's reachable on the venue WiFi from phones during dev, not just localhost
    port: Number(process.env.PORT) || 5173,
  },
});
