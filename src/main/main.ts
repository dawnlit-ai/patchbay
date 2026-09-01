import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'node:path';
import { IPC } from '@shared/ipc';
import { getAgentControl, getWatcher, registerIpc } from './ipc';
import { migrateToFlowDirectories } from './store/flowStore';
import { seedGlobalLibrary } from './store/skillStore';
import { workspaceRoot } from './paths';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

/** Matches the step and range Chromium's own zoom shortcuts use. */
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 6;

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
        // The top bar draws the name and the minimise/maximise/close buttons itself,
        // so the OS frame would only repeat them a row higher.
        frame: false,
        webPreferences: {
            preload: join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    // The maximise button offers whichever state the window is not in, and the
    // window can reach either without it — a drag to the top edge, a snap shortcut.
    const sendMaximized = (): void => {
        if (!win.isDestroyed()) win.webContents.send(IPC.evtWindowMaximized, win.isMaximized());
    };
    win.on('maximize', sendMaximized);
    win.on('unmaximize', sendMaximized);

    // Dropping the default menu also dropped its zoomIn/zoomOut/resetZoom roles,
    // which were what bound Ctrl+Plus, Ctrl+Minus and Ctrl+0. Rebind them on the
    // window so the shortcuts survive without a menu bar to host them.
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;

        const level = win.webContents.getZoomLevel();
        let next: number;
        if (input.key === '+' || input.key === '=') next = level + ZOOM_STEP;
        else if (input.key === '-' || input.key === '_') next = level - ZOOM_STEP;
        else if (input.key === '0') next = 0;
        else return;

        win.webContents.setZoomLevel(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next)));
        event.preventDefault();
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
        void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }
}

void app.whenReady().then(() => {
    // Nothing in the default File/Edit/View/Window menu belongs to this app, so it
    // goes on every platform: off the window on Windows and Linux, out of the system
    // bar on macOS.
    Menu.setApplicationMenu(null);
    workspaceRoot();
    // Flows used to be loose files sharing one library; a workspace written before
    // that changed is rearranged here, once, before anything reads it.
    const migrated = migrateToFlowDirectories();
    if (migrated.length > 0) console.log(`Gave ${migrated.length} flow(s) a directory of their own`);
    const seeded = seedGlobalLibrary();
    if (seeded.length > 0) console.log(`Seeded the global skill library: ${seeded.join(', ')}`);
    registerIpc();
    // Listens only if the workspace says so; a settings edit is what turns it on.
    getAgentControl().apply();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length !== 0) return;
        createWindow();
        // The control server stopped with the last window, on the grounds that an
        // app with nothing on screen is not one to drive; a window is back, so it is.
        getAgentControl().apply();
    });
});

app.on('window-all-closed', () => {
    // Watching is a foreground activity here: no window, no poller. The same goes
    // for the agent-control server — an app with nothing on screen is not one an
    // agent should still be able to drive.
    getWatcher().stop();
    getAgentControl().stop();
    if (process.platform !== 'darwin') app.quit();
});
