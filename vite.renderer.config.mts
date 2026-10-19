import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { alias } from './vite.shared.mjs';

export default defineConfig({
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {alias},
    build: {
        // Forge's relative outDir would resolve under `root` (src/renderer), where the
        // packaged main process can't find it. The name matches forge.config.ts.
        outDir: resolve(import.meta.dirname, '.vite/renderer/main_window'),
    },
});
