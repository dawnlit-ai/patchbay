import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { getWatcher, registerIpc } from './ipc';
import { seedSkillLibrary } from './store/skillStore';
import { getSettings } from './store/settingsStore';
import { workspaceRoot } from './paths';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

function createWindow(): void {
    const win = new BrowserWindow({
        width: 1560,
        height: 980,
        minWidth: 1100,
        minHeight: 700,
        // Matches the light theme's --bg, so launching does not flash a dark frame
        // before the renderer paints.
        backgroundColor: '#f4f6f9',
        title: 'Patchbay',
        webPreferences: {
            preload: join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
        void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }
}

/**
 * Where to look for skills to seed the library from, in order, and only while it
 * is empty: the folder named in Settings, then a `skills` directory beside the
 * app. A machine with neither gets the starter skill instead, and Skills →
 * Import… covers anywhere else.
 */
function skillSeedCandidates(): string[] {
    return [getSettings().skillSeedPath, join(process.cwd(), 'skills')];
}

void app.whenReady().then(() => {
    workspaceRoot();
    const seeded = seedSkillLibrary(skillSeedCandidates());
    if (seeded.length > 0) console.log(`Seeded skill library: ${seeded.join(', ')}`);
    registerIpc();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    // Watching a mailbox is a foreground activity here: closing the window stops
    // the poller rather than leaving runs firing with nothing to show them in.
    getWatcher().stop();
    if (process.platform !== 'darwin') app.quit();
});
