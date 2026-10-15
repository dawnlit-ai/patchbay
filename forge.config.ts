import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';

/**
 * What the main bundle leaves out (vite.main.config.mts), shipped as packages, by
 * the parts of each a run needs; null is all of it. zod is the Agent SDK's one
 * import, and the platform package is its own Claude Code.
 */
const SHIPPED: Record<string, string[] | null> = {
    '@anthropic-ai/claude-agent-sdk': null,
    [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`]: null,
    // A link to the sibling checkout, which holds its sources and .git too.
    '@dawnlit/outlook-bridge': ['package.json', 'dist'],
    // The updater, and the loader that picks its native add-on for the platform.
    velopack: null,
    '@neon-rs/load': null,
    zod: null,
};

/** Whether a path in the project, written `/a/b`, goes in the package. */
function packaged(file: string): boolean {
    if (file === '' || file === '/package.json' || file.startsWith('/.vite')) return true;
    return Object.entries(SHIPPED).some(([name, parts]) => {
        const root = `/node_modules/${name}`;
        if (`${root}/`.startsWith(`${file}/`)) return true;
        if (!file.startsWith(`${root}/`)) return false;
        const part = file.slice(root.length + 1).split('/')[0] ?? '';
        return parts === null || parts.includes(part);
    });
}

const config: ForgeConfig = {
    // The packaged app takes its name from package.json's productName, which
    // packager infers when packagerConfig does not name one itself.
    packagerConfig: {
        // Set here, the Vite plugin's own (`.vite` alone) gives way to it.
        ignore: (file) => !packaged(file),
        // Off: the Agent SDK spawns its Claude Code at the path it resolves, and
        // a path inside app.asar cannot be spawned even when unpacked.
        asar: false,
        // macOS files the permission to control Outlook under this and the signing
        // certificate together: changing either asks every Mac user for it again.
        appBundleId: 'com.dawnlit.patchbay',
        extendInfo: {
            NSAppleEventsUsageDescription: 'Patchbay reads, files and drafts your mail by driving Outlook.',
        },
    },
    // None: `npm run dist` hands the packaged app to Velopack (scripts/dist.mts),
    // which makes the portable zip and the packages the app updates itself from.
    makers: [],
    plugins: [
        new VitePlugin({
            build: [
                {
                    entry: 'src/main/main.ts',
                    config: 'vite.main.config.mts',
                    target: 'main',
                },
                {
                    entry: 'src/preload/preload.ts',
                    config: 'vite.preload.config.mts',
                    target: 'preload',
                },
            ],
            // The renderer's name is what the plugin defines
            // MAIN_WINDOW_VITE_DEV_SERVER_URL and MAIN_WINDOW_VITE_NAME from —
            // the two constants windows.ts loads a window through.
            renderer: [
                {
                    name: 'main_window',
                    config: 'vite.renderer.config.mts',
                },
            ],
        }),
    ],
};

export default config;
