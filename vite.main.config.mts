import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The main process keeps three dependencies external rather than bundling them:
// the Agent SDK spawns a native `claude` binary it locates relative to its own
// package, outlook-bridge writes PowerShell/AppleScript scratch files the same
// way, and electron is supplied by the runtime.
export default defineConfig({
    resolve: {
        alias: { '@shared': resolve(import.meta.dirname, 'src/shared') },
    },
    build: {
        rollupOptions: {
            external: [
                'electron',
                '@anthropic-ai/claude-agent-sdk',
                '@dawnlit/outlook-bridge',
                /^node:/,
            ],
        },
    },
});
