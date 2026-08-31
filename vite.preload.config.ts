import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  build: {
    rollupOptions: {
      external: ['electron', /^node:/],
    },
  },
});
