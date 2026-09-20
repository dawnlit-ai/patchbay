import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { IPC } from '@shared/ipc';

/**
 * Two windows, one renderer build. The welcome window is the app's start page —
 * the flows this install holds, and everything you can do to one without opening
 * it. The project window is the canvas for the flow you chose, and it is the only
 * one of the two that needs the room, which is why they are separate windows
 * rather than a screen the canvas has to make space for.
 *
 * Which is which is the hash the window loads with, read before React renders,
 * so neither paints the other's layout first.
 */

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

/** Matches the step and range Chromium's own zoom shortcuts use. */
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 6;

let welcome: BrowserWindow | null = null;
let project: BrowserWindow | null = null;

interface Frame {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    resizable?: boolean;
    maximizable?: boolean;
}

function make(frame: Frame): BrowserWindow {
    const win = new BrowserWindow({
        ...frame,
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

    return win;
}

function load(win: BrowserWindow, hash: string): void {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        void win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${hash}`);
    } else {
        void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), { hash });
    }
}

function raise(win: BrowserWindow): void {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

/** The start page: opened at launch, and again whenever a flow is asked for. */
export function showWelcome(): void {
    if (welcome && !welcome.isDestroyed()) {
        raise(welcome);
        return;
    }
    // Deliberately not the canvas's size. It lists flows, so it wants the shape of
    // a list; anything wider is empty space with a scrollbar down one side.
    welcome = make({ width: 940, height: 640, minWidth: 760, minHeight: 520, maximizable: false });
    welcome.on('closed', () => {
        welcome = null;
    });
    load(welcome, 'welcome');
}

/**
 * Put a flow on the canvas. One project window at a time: the canvas, the runs
 * and the console are one workspace's worth of state, and a second copy of them
 * would be two windows disagreeing about what just ran. So an open one switches
 * flows in place, and the start window closes behind it either way.
 */
export function openFlow(flowId: string): void {
    if (project && !project.isDestroyed()) {
        project.webContents.send(IPC.evtOpenFlow, flowId);
        raise(project);
    } else {
        project = make({ width: 1560, height: 980, minWidth: 1100, minHeight: 700 });
        project.on('closed', () => {
            project = null;
        });
        load(project, `flow=${encodeURIComponent(flowId)}`);
    }
    // Closed after the canvas exists, so the app is never momentarily windowless —
    // which on Windows and Linux is what quitting looks like.
    if (welcome && !welcome.isDestroyed()) welcome.close();
}

export function anyWindowOpen(): boolean {
    return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed());
}
