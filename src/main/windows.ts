import { app, BrowserWindow, type Input, type Rectangle, screen } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { IPC, type OpenWhere } from '@shared/ipc';
import { type DisplayArea, WINDOW_KINDS, WINDOW_SIZES, type WindowKind, type WindowSize } from '@shared/settings';
import { getSettings } from './store/settingsStore';

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
/** The window of any kind brought to the front last, which comes back in front of the rest. */
let lastUsed: BrowserWindow | null = null;
/**
 * Windows minimised into the tray: hidden, with no taskbar button, until the
 * tray icon brings them back. Kept here because Windows calls a window
 * minimised to the taskbar not visible too, so visibility cannot tell the two apart.
 */
const inTray = new Set<BrowserWindow>();

interface Frame {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    x?: number;
    y?: number;
    maximizable?: boolean;
}

/** In development on Windows and Linux, give windows Patchbay's icon; packaged builds inherit it from the executable. */
function devWindowIcon(): string | undefined {
    if (app.isPackaged || process.platform === 'darwin') return undefined;
    const icon = join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
    return existsSync(icon) ? icon : undefined;
}

function make(frame: Frame): BrowserWindow {
    const win = new BrowserWindow({
        ...frame,
        icon: devWindowIcon(),
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

    win.on('focus', () => {
        lastUsed = win;
    });
    win.on('closed', () => {
        if (lastUsed === win) lastUsed = null;
        inTray.delete(win);
    });

    // Chromium opens a file dropped outside any drop target (an Outlook email that
    // misses a trigger) in place of the app. Refuse navigation off this page.
    win.webContents.on('will-navigate', (event) => {
        const page = (url: string): string => url.split('#')[0] ?? url;
        if (page(event.url) !== page(win.webContents.getURL())) event.preventDefault();
    });

    // Removing the default menu removed its zoom and developer-tools shortcuts;
    // rebind Ctrl+Plus/Minus/0 here, and the developer tools' once Settings allows them.
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;

        if (isDevToolsKey(input)) {
            if (!getSettings().devToolsEnabled) return;
            win.webContents.toggleDevTools();
            event.preventDefault();
            return;
        }

        if (!input.control || input.alt || input.meta) return;

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

/**
 * F12, or Chromium's own Ctrl+Shift+I (Cmd+Option+I on a Mac). Read by the key's
 * place, not its character: Option turns I into another letter on a Mac.
 */
function isDevToolsKey(input: Input): boolean {
    if (input.key === 'F12') return !input.control && !input.alt && !input.meta && !input.shift;
    if (input.code !== 'KeyI') return false;
    return process.platform === 'darwin'
        ? input.meta && input.alt && !input.control && !input.shift
        : input.control && input.shift && !input.alt && !input.meta;
}

/** Every open window of a kind. */
function windowsOf(kind: WindowKind): BrowserWindow[] {
    const open = kind === 'canvas' ? projects.map((p) => p.win) : [kind === 'welcome' ? welcome : settings];
    return open.filter((win): win is BrowserWindow => win !== null && !win.isDestroyed());
}

/**
 * Give the open windows of each kind whose size Settings just changed the new
 * one: each keeps its top-left corner where its screen has room, and is shrunk
 * to fit where it has not. One maximised, full screen or minimised stays as it is.
 */
export function resizeOpen(before: Record<WindowKind, WindowSize>, after: Record<WindowKind, WindowSize>): void {
    for (const kind of WINDOW_KINDS) {
        const {width, height} = after[kind];
        if (width === before[kind].width && height === before[kind].height) continue;
        for (const win of windowsOf(kind)) {
            if (win.isMaximized() || win.isFullScreen() || win.isMinimized()) continue;
            const bounds = win.getBounds();
            const area = screen.getDisplayMatching(bounds).workArea;
            const w = Math.min(width, area.width);
            const h = Math.min(height, area.height);
            win.setBounds({
                x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - w)),
                y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - h)),
                width: w,
                height: h,
            });
        }
    }
}

/** How much of the screen `win` is mostly on windows may use. */
export function displayArea(win: BrowserWindow): DisplayArea {
    const display = screen.getDisplayMatching(win.getBounds());
    return {width: display.workArea.width, height: display.workArea.height, label: display.label ?? ''};
}

/** Close the developer tools on every window: they were just switched off in Settings. */
export function closeDevTools(): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
    }
}

/** A kind of window at the size Settings gives it, and no smaller than its layout needs. */
function sizedAs(kind: WindowKind): Frame {
    const {width, height} = getSettings().windowSizes[kind];
    const {min} = WINDOW_SIZES[kind];
    return {width, height, minWidth: min.width, minHeight: min.height};
}

/**
 * A window as large as asked where its screen has room for it, and no larger
 * than the screen where it has not: a laptop at 150% scaling has about 670
 * points of height above the taskbar. Centred on the screen the pointer is on,
 * which is the one it was sized for.
 */
function fitted(frame: Frame): Frame {
    return within(frame, screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
}

/** A frame no larger than `area`, centred on it. */
function within(frame: Frame, area: Rectangle): Frame {
    const width = Math.min(frame.width, area.width);
    const height = Math.min(frame.height, area.height);
    return {
        ...frame,
        width,
        height,
        minWidth: Math.min(frame.minWidth, width),
        minHeight: Math.min(frame.minHeight, height),
        x: area.x + Math.round((area.width - width) / 2),
        y: area.y + Math.round((area.height - height) / 2),
    };
}

function load(win: BrowserWindow, hash: string): void {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        void win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${hash}`);
    } else {
        void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {hash});
    }
}

function raise(win: BrowserWindow): void {
    inTray.delete(win);
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
 * Offset a new canvas from the last one, kept inside that display and no larger
 * than it. Electron would centre it exactly on top, where it looks like nothing
 * happened. With no canvas to sit beside, it is centred like any other window.
 */
function beside(frame: Frame): Frame {
    const from = projects[0]?.win;
    if (!from || from.isDestroyed() || from.isMaximized() || from.isFullScreen()) return fitted(frame);
    const bounds = from.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const fit = within(frame, area);
    return {
        ...fit,
        x: Math.max(area.x, Math.min(bounds.x + CASCADE_STEP, area.x + area.width - fit.width)),
        y: Math.max(area.y, Math.min(bounds.y + CASCADE_STEP, area.y + area.height - fit.height)),
    };
}

/** The start page: opened at launch, and again whenever a flow is asked for. */
export function showWelcome(): void {
    if (welcome && !welcome.isDestroyed()) {
        raise(welcome);
        return;
    }
    welcome = make(fitted({...sizedAs('welcome'), maximizable: false}));
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
    settings = make(fitted({...sizedAs('settings'), maximizable: false}));
    settings.on('closed', () => {
        settings = null;
    });
    // Settings → Appearance suggests sizes from the screen it is on, which a move may change.
    settings.on('moved', () => settings?.webContents.send(IPC.evtWindowMoved));
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
        const win = make(beside(sizedAs('canvas')));
        if (getSettings().canvasMaximized) win.maximize();
        track({win, flowId});
        load(win, `flow=${encodeURIComponent(flowId)}`);
    }
    // Closed after the canvas exists, so the app is never momentarily windowless —
    // which on Windows and Linux is what quitting looks like.
    if (welcome && !welcome.isDestroyed()) welcome.close();
}

/** Close every canvas: their flows belong to a workspace no longer open. Shows the start page first, so the app is never windowless. */
export function closeCanvases(): void {
    if (projects.length === 0) return;
    showWelcome();
    for (const {win} of [...projects]) if (!win.isDestroyed()) win.close();
}

/** The flow on each canvas, the window last used first. */
export function openFlows(): string[] {
    return projects.map((p) => p.flowId);
}

/**
 * Bring Patchbay back, as its tray icon, the Dock and a second launch do: the
 * windows hidden in the tray, the one used last in front of the rest, or with
 * none hidden, the one used last, restored if minimised. With none open, the
 * start page.
 */
export function showAll(): void {
    const open = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    const last = lastUsed && !lastUsed.isDestroyed() ? lastUsed : undefined;
    const hidden = open.filter((win) => inTray.has(win));
    if (hidden.length > 0) {
        for (const win of hidden) if (win !== last) raise(win);
        if (last && hidden.includes(last)) raise(last);
        return;
    }
    const front = last ?? open[0];
    if (front) raise(front);
    else showWelcome();
}

/** Take a window just minimised off the taskbar, into the tray. */
export function hideInTray(win: BrowserWindow): void {
    inTray.add(win);
    win.hide();
}

/**
 * Put every window hidden in the tray back on the screen, without taking the
 * focus: the tray icon is going, and nothing else would bring them back.
 */
export function showHidden(): void {
    for (const win of inTray) if (!win.isDestroyed()) win.showInactive();
    inTray.clear();
}

/** Whether any window is still on the screen or the taskbar: open, and not hidden in the tray. */
export function onScreen(): boolean {
    return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && !inTray.has(win));
}
