import { app, dialog, Menu, type NativeImage, nativeImage, Tray } from 'electron';
import type { EngineStatus } from '@shared/settings';
import { getSettings } from './store/settingsStore';
import { drawTrayIcon, ICON_POINTS, type TrayState } from './trayIcon';
import { hideInTray, onScreen, showAll, showHidden, showSettings } from './windows';

/**
 * Patchbay's icon in the system tray, or the menu bar on a Mac, while Settings
 * has it on. With it there, closing the last window leaves Patchbay running —
 * still watching the flows switched on, and finishing the runs under way — and
 * the icon is how it is opened again, or quit. Its dot says what it is doing:
 * none when nothing is watched, green while flows are, amber while runs are in hand.
 */

const ON_MAC = process.platform === 'darwin';

/** A Mac's menu bar takes a template at 1× and 2×; Windows takes the size for whatever scaling the screen is set to. */
const SCALES = ON_MAC ? [1, 2] : [1, 1.25, 1.5, 1.75, 2];

const images = new Map<TrayState, NativeImage>();

function image(state: TrayState): NativeImage {
    let made = images.get(state);
    if (!made) {
        made = nativeImage.createEmpty();
        for (const scaleFactor of SCALES) {
            const size = Math.round(ICON_POINTS * scaleFactor);
            made.addRepresentation({scaleFactor, width: size, height: size, buffer: drawTrayIcon(size, state, ON_MAC)});
        }
        if (ON_MAC) made.setTemplateImage(true);
        images.set(state, made);
    }
    return made;
}

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The runs the watcher has in hand, in a line — what quitting would cut short — or null with none. */
function work({activeRunIds, queuedRunIds, reviewingRunIds}: EngineStatus): string | null {
    const parts = (
        [
            [activeRunIds.length, 'under way'],
            [queuedRunIds.length, 'waiting'],
            [reviewingRunIds.length, 'under review'],
        ] as const
    ).filter(([n]) => n > 0);
    if (parts.length === 0) return null;
    return parts.map(([n, what], i) => (i === 0 ? `${count(n, 'run')} ${what}` : `${n} ${what}`)).join(' · ');
}

/** What the tooltip and the menu say Patchbay is doing: which flows it watches, and the runs it has in hand. */
function summary(status: EngineStatus): string[] {
    const flows = status.flowIds.length;
    const watching = flows === 0 ? 'Not watching any flow' : `Watching ${count(flows, 'flow')}`;
    const runs = work(status);
    return runs ? [watching, runs] : [watching];
}

function stateOf(status: EngineStatus): TrayState {
    if (work(status)) return 'busy';
    return status.flowIds.length > 0 ? 'watching' : 'idle';
}

export interface TrayHost {
    /** What the watcher is doing, for the dot, the tooltip and the menu. */
    status(): EngineStatus;
}

export class TrayIcon {
    private tray: Tray | null = null;
    /** What the icon and its menu last said, so a poll that changes nothing redraws nothing. */
    private showing = '';
    /** Whether this launch has said where Patchbay went, the first time it left the screen. */
    private told = false;

    constructor(private readonly host: TrayHost) {
        // A window minimised, by its own button, the taskbar or Win+Down, leaves the
        // taskbar for the tray while Settings says so and the icon is there to bring
        // it back. Not on a Mac, whose Dock is where a minimised window belongs.
        app.on('browser-window-created', (_event, win) => {
            win.on('minimize', () => {
                if (ON_MAC || !this.tray || !getSettings().minimizeToTray) return;
                hideInTray(win);
                this.tell();
            });
        });
    }

    /** There while Settings has it on. Taken away, it first gives back every window hidden in it. */
    apply(): void {
        const wanted = getSettings().runInTray;
        if (wanted && !this.tray) {
            this.tray = new Tray(image(stateOf(this.host.status())));
            // A click opens Patchbay and a right-click the menu. A Mac's menu bar
            // opens the menu on a click, which is why the menu says Open first.
            if (!ON_MAC) this.tray.on('click', () => showAll());
            this.showing = '';
            this.refresh();
        } else if (!wanted && this.tray) {
            this.tray.destroy();
            this.tray = null;
            showHidden();
        }
    }

    /** The watcher's status changed: the dot, the tooltip and the menu follow it. */
    refresh(): void {
        if (!this.tray) return;
        const status = this.host.status();
        const state = stateOf(status);
        const lines = summary(status);
        const showing = [state, ...lines].join('\n');
        if (showing === this.showing) return;
        this.showing = showing;
        this.tray.setImage(image(state));
        this.tray.setToolTip(['Patchbay', ...lines].join('\n'));
        this.tray.setContextMenu(
            Menu.buildFromTemplate([
                {label: 'Open Patchbay', click: () => showAll()},
                {type: 'separator'},
                ...lines.map((label) => ({label, enabled: false})),
                {type: 'separator'},
                {label: 'Settings…', click: () => showSettings()},
                {type: 'separator'},
                {label: 'Quit Patchbay', click: () => void this.quit()},
            ]),
        );
    }

    /**
     * The last window has closed. Whether the icon keeps Patchbay running —
     * watching, and finishing its runs — or there is none and it stops.
     */
    holdOpen(): boolean {
        if (!this.tray) return false;
        this.tell();
        return true;
    }

    /**
     * Once a launch, when no window is left on the screen: say Patchbay is still
     * running, and where. Windows tucks a new icon behind the arrow at the end of
     * the taskbar, where it would look as if Patchbay had quit. A Mac's menu bar
     * shows it.
     */
    private tell(): void {
        if (this.told || !this.tray || ON_MAC || onScreen()) return;
        this.told = true;
        this.tray.displayBalloon({
            title: 'Patchbay is still running',
            content: `${summary(this.host.status())[0]}. Click its icon in the system tray to open it again, or right-click it to quit.`,
            noSound: true,
            respectQuietTime: true,
        });
    }

    /** Asks first while runs are in hand, which quitting cuts short. */
    private async quit(): Promise<void> {
        const runs = work(this.host.status());
        if (runs) {
            const {response} = await dialog.showMessageBox({
                type: 'warning',
                buttons: ['Quit', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                message: 'Quit Patchbay before its runs finish?',
                detail: `${runs}. Quitting cuts them short, and stops every flow being watched.`,
            });
            if (response !== 0) return;
        }
        app.quit();
    }
}
