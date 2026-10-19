import { defineConfig } from 'vite';
import { alias } from './vite.shared.mjs';

export default defineConfig({
    resolve: {alias},
    build: {
        rollupOptions: {
            external: ['electron', /^node:/],
        },
    },
});
