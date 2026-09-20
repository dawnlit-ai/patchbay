import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';

const config: ForgeConfig = {
    // The packaged app takes its name from package.json's productName, which
    // packager infers when packagerConfig does not name one itself.
    packagerConfig: {
        asar: true,
    },
    makers: [new MakerSquirrel(), new MakerZIP({}, ['win32', 'darwin'])],
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
