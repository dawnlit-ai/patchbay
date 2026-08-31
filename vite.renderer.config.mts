import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
        alias: { '@shared': resolve(import.meta.dirname, 'src/shared') },
    },
    build: {
        // Electron Forge hands us a relative `.vite/renderer/<name>` outDir, which the
        // renderer root above would otherwise resolve to src/renderer/.vite/... — out
        // of reach of the `../renderer/<name>/index.html` the main process loads once
        // packaged. Anchor it to the project root instead. The name matches the
        // renderer entry in forge.config.ts.
        outDir: resolve(import.meta.dirname, '.vite/renderer/main_window'),
    },
});
