import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(import.meta.dirname, 'src/shared') },
  },
  build: {
    rollupOptions: {
      external: ['electron', /^node:/],
    },
  },
});
