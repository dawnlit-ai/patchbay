import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import { getWatcher, hasUnsavedFlow, registerIpc } from './ipc';
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

    // With auto-save off the canvas can hold edits no file has yet, and closing
    // would drop them without a word.
    win.on('close', (event) => {
        if (!hasUnsavedFlow()) return;
        const choice = dialog.showMessageBoxSync(win, {
            type: 'warning',
            buttons: ['Cancel', 'Discard changes'],
            defaultId: 0,
            cancelId: 0,
            message: 'This flow has unsaved changes.',
            detail: 'Cancel and press Save (Ctrl+S), or close and lose the edits made since the last save.',
        });
        if (choice === 0) event.preventDefault();
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
        void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }
}

/**
 * Seed folders to try in order: the one named in Settings, then a `skills`
 * directory beside the app. With neither, the library gets the starter skill.
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
    // Watching is a foreground activity here: no window, no poller.
    getWatcher().stop();
    if (process.platform !== 'darwin') app.quit();
});
