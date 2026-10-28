import { defineConfig } from 'vite';

// Forge already leaves out electron and Node's built-ins. Also not bundled: the
// Agent SDK and outlook-bridge find files relative to their own package, and
// velopack loads its native add-on relative to its own.
export default defineConfig({
    resolve: {tsconfigPaths: true},
    build: {
        rollupOptions: {
            external: ['@anthropic-ai/claude-agent-sdk', '@dawnlit/outlook-bridge', 'velopack'],
        },
    },
});
