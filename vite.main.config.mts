import { defineConfig } from 'vite';
import { alias } from './vite.shared.mjs';

// Not bundled: the Agent SDK and outlook-bridge find files relative to their own
// package, and electron comes from the runtime.
export default defineConfig({
    resolve: { alias },
    build: {
        rollupOptions: {
            external: [
                'electron',
                '@anthropic-ai/claude-agent-sdk',
                '@dawnlit/outlook-bridge',
                // Loads its native add-on relative to its own package.
                'velopack',
                /^node:/,
            ],
        },
    },
});
