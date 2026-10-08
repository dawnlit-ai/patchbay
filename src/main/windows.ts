import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { IPC, type OpenWhere } from '@shared/ipc';

/**
 * Three kinds of window from one renderer build: the welcome window (the flow
 * list), one canvas per open flow, and a single settings window. The hash each
 * loads with says which, and is read before React renders.
 */

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

/** Matches the step and range Chromium's own zoom shortcuts use. */
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 6;

/** How far a second canvas sits from the one it was opened beside. */
const CASCADE_STEP = 34;

/** A canvas window, and the flow on it. */
interface Project {
    win: BrowserWindow;
    flowId: string;
}

let welcome: BrowserWindow | null = null;
let settings: BrowserWindow | null = null;
/** Every canvas open, the one used most recently first. */
const projects: Project[] = [];

interface Frame {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    x?: number;
    y?: number;
    maximizable?: boolean;
}

function make(frame: Frame): BrowserWindow {
    const win = new BrowserWindow({
        ...frame,
        // Matches the light theme's --bg, so launching does not flash a dark frame
        // before the renderer paints.
        backgroundColor: '#f4f6f9',
        title: 'Patchbay',
        // The top bar draws the title and window buttons itself.
        frame: false,
        webPreferences: {
            preload: join(__dirname, 'preload.cjs'),
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

    // Chromium opens a file dropped outside any drop target (an Outlook email that
    // misses a trigger) in place of the app. Refuse navigation off this page.
    win.webContents.on('will-navigate', (event) => {
        const page = (url: string): string => url.split('#')[0] ?? url;
        if (page(event.url) !== page(win.webContents.getURL())) event.preventDefault();
    });

    // Removing the default menu removed its zoom shortcuts; rebind Ctrl+Plus/Minus/0 here.
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

/** Keeps canvases in most-recently-used order, so the one offered for reuse is the one last looked at. */
function track(project: Project): void {
    projects.unshift(project);
    project.win.on('focus', () => {
        const at = projects.indexOf(project);
        if (at <= 0) return;
        projects.splice(at, 1);
        projects.unshift(project);
    });
    project.win.on('closed', () => {
        const at = projects.indexOf(project);
        if (at !== -1) projects.splice(at, 1);
    });
}

/**
 * Offset a new canvas from the last one, kept inside that display. Electron would
 * centre it exactly on top, where it looks like nothing happened.
 */
function beside(frame: Frame): Frame {
    const from = projects[0]?.win;
    if (!from || from.isDestroyed() || from.isMaximized() || from.isFullScreen()) return frame;
    const bounds = from.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    return {
        ...frame,
        x: Math.max(area.x, Math.min(bounds.x + CASCADE_STEP, area.x + area.width - frame.width)),
        y: Math.max(area.y, Math.min(bounds.y + CASCADE_STEP, area.y + area.height - frame.height)),
    };
}

/** The start page: opened at launch, and again whenever a flow is asked for. */
export function showWelcome(): void {
    if (welcome && !welcome.isDestroyed()) {
        raise(welcome);
        return;
    }
    // Sized for a list, not a canvas.
    welcome = make({ width: 940, height: 640, minWidth: 760, minHeight: 520, maximizable: false });
    welcome.on('closed', () => {
        welcome = null;
    });
    load(welcome, 'welcome');
}

/** The settings window. Only ever one, since two would save over each other. */
export function showSettings(): void {
    if (settings && !settings.isDestroyed()) {
        raise(settings);
        return;
    }
    settings = make({ width: 820, height: 600, minWidth: 700, minHeight: 480, maximizable: false });
    settings.on('closed', () => {
        settings = null;
    });
    load(settings, 'settings');
}

/**
 * Put a flow on a canvas. A flow already open raises its window, since two
 * canvases on one file would save over each other. Otherwise `where` picks the
 * last-used canvas or a new one.
 */
export function openFlow(flowId: string, where: OpenWhere = 'current'): void {
    const already = projects.find((p) => p.flowId === flowId);
    const current = projects[0];
    if (already) {
        raise(already.win);
    } else if (where === 'current' && current) {
        // The window keeps its place in the list; only the flow on it changes.
        current.flowId = flowId;
        current.win.webContents.send(IPC.evtOpenFlow, flowId);
        raise(current.win);
    } else {
        // `beside` reads the canvas in front, so it is asked before the new one
        // takes that place.
        const win = make(beside({ width: 1560, height: 980, minWidth: 1100, minHeight: 700 }));
        track({ win, flowId });
        load(win, `flow=${encodeURIComponent(flowId)}`);
    }
    // Closed after the canvas exists, so the app is never momentarily windowless —
    // which on Windows and Linux is what quitting looks like.
    if (welcome && !welcome.isDestroyed()) welcome.close();
}

/** The flow on each canvas, the window last used first. */
export function openFlows(): string[] {
    return projects.map((p) => p.flowId);
}

export function anyWindowOpen(): boolean {
    return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed());
}
