import { defineConfig } from 'vite';

// Same shape as elo-tuner/: no framework, no build step to think about, and the API is proxied to
// the NUC so the lab runs from a laptop without CORS. Port 5174 so both tools can be open at once.
export default defineConfig({
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://192.168.1.74:8088',
        changeOrigin: true,
      },
    },
  },
});
