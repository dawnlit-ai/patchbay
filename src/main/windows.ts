import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { IPC, type OpenWhere } from '@shared/ipc';

/**
 * Three kinds of window, one renderer build. The welcome window is the app's start
 * page — the flows this install holds, and everything you can do to one without
 * opening it. A canvas window holds one flow being drawn, and there may be
 * several of them: the canvas is the half that wants the desk, which is why the
 * start page is a window rather than a screen it has to make room for. The
 * settings window holds what belongs to the install rather than to any one flow,
 * so it is raised from any of the others instead of living in a canvas's panel.
 *
 * Which is which is the hash the window loads with, read before React renders,
 * so none paints another's layout first.
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

    // A file dropped anywhere nothing takes it — an email dragged out of Outlook
    // that misses the trigger, say — is opened by Chromium in place of the app.
    // The app moves between its own views by hash, so a navigation that leaves
    // its page is one to refuse; a reload of the page itself is not.
    win.webContents.on('will-navigate', (event) => {
        const page = (url: string): string => url.split('#')[0] ?? url;
        if (page(event.url) !== page(win.webContents.getURL())) event.preventDefault();
    });

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

/**
 * Keeps the list in the order the windows were last used, so the canvas the
 * welcome window offers to take over is the one whoever is choosing was just
 * looking at, rather than whichever opened first.
 */
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
 * Where a second canvas goes. Left to itself Electron centres a window, which
 * puts it exactly on top of the one it was opened beside — from the front, a
 * second window and nothing happening look the same. So it steps off the last
 * canvas, and is pushed back inside that display rather than over its edge.
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
    // Deliberately not the canvas's size. It lists flows, so it wants the shape of
    // a list; anything wider is empty space with a scrollbar down one side.
    welcome = make({ width: 940, height: 640, minWidth: 760, minHeight: 520, maximizable: false });
    welcome.on('closed', () => {
        welcome = null;
    });
    load(welcome, 'welcome');
}

/**
 * The settings window, raised from the gear in any other window's bar. Only ever
 * one: two would be two drafts of the same file, each saving over the other. A
 * rail of pages and one short page beside it, so smaller than the start page.
 */
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
 * Put a flow on a canvas. A flow already on one raises that window instead of
 * opening a second copy: two canvases on one graph would be two editors of one
 * file, each saving over the other. Otherwise `where` decides — the canvas last
 * used takes this flow in place of its own, or a new one opens beside it — and
 * with no canvas open at all there is nothing to decide. The runs and the
 * console are the whole workspace's, so either answer shows the same ones.
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
