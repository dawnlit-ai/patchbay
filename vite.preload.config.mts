import { defineConfig } from 'vite';

// Forge already leaves out electron and Node's built-ins.
export default defineConfig({
    resolve: {tsconfigPaths: true},
});
