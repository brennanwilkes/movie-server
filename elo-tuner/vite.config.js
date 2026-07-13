import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://192.168.1.74:8088',
        changeOrigin: true,
      },
      '/jf-img': {
        target: 'http://192.168.1.74:8096',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/jf-img/, ''),
      },
    },
  },
});
