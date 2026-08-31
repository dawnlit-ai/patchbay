import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';

// Electron Forge's preload config asks for a single chunk through rollup's
// `output.inlineDynamicImports`, which rolldown now warns is deprecated on every
// build. Restate the same intent with its replacement and drop the old key, which
// a plain config merge cannot do. Remove once @electron-forge/plugin-vite moves
// over to `codeSplitting`.
const preferCodeSplittingFlag = (): Plugin => ({
    name: 'patchbay:preload-code-splitting',
    config(config) {
        const output = config.build?.rollupOptions?.output;
        if (output && !Array.isArray(output)) {
            delete output.inlineDynamicImports;
            output.codeSplitting = false;
        }
    },
});

export default defineConfig({
    plugins: [preferCodeSplittingFlag()],
    resolve: {
        alias: { '@shared': resolve(import.meta.dirname, 'src/shared') },
    },
    build: {
        rollupOptions: {
            external: ['electron', /^node:/],
        },
    },
});
