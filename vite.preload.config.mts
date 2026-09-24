import { defineConfig, type Plugin } from 'vite';
import { alias } from './vite.shared.mjs';

// Swaps Forge's deprecated `inlineDynamicImports` for `codeSplitting: false` to
// silence rolldown's warning. Remove once @electron-forge/plugin-vite does this.
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
    resolve: { alias },
    build: {
        rollupOptions: {
            external: ['electron', /^node:/],
        },
    },
});
