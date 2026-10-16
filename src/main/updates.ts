import { app, dialog } from 'electron';
import { GithubSource, type UpdateInfo, UpdateManager, type UpdateSource } from 'velopack';
import type { UpdateChannel, UpdateStatus } from '@shared/settings';
import { getSettings } from './store/settingsStore';
import { log } from './log';

/**
 * Where releases are published. Read without a token, which GitHub allows 60 times
 * an hour from one address — a check every few hours is far inside that.
 */
const REPO_URL = 'https://github.com/dawnlit-ai/patchbay';

/** The first check waits for the app to settle; after that, one every few hours while it stays open. */
const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 4 * 3_600_000;

/**
 * Started with `--update-feed=<folder or URL>`, a build checks that feed instead of
 * GitHub: how a release is tried before it is published.
 */
const FEED_FLAG = '--update-feed=';

/** Velopack's name for what this build runs on. Each channel's feed is published under it. */
function platformChannel(): string | null {
    const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'osx' : null;
    return os && (process.arch === 'x64' || process.arch === 'arm64') ? `${os}-${process.arch}` : null;
}

function manager(channel: UpdateChannel): UpdateManager {
    const feed = process.argv.find((arg) => arg.startsWith(FEED_FLAG))?.slice(FEED_FLAG.length);
    const source: UpdateSource = feed ?? new GithubSource(REPO_URL, undefined, channel === 'nightly');
    return new UpdateManager(source, {
        ExplicitChannel: `${platformChannel()}${channel === 'nightly' ? '-nightly' : ''}`,
        // Leaving nightlies for stable lands on a lower version: that is the point of leaving.
        AllowVersionDowngrade: true,
        MaximumDeltasBeforeFallback: 10,
    });
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface UpdateHost {
    /** Whether a run is under way or waiting, which a restart would cut short. */
    busy(): boolean;
}

/**
 * Checks the chosen channel, downloads what it finds in the background, and
 * restarts into it when asked. A download left unused is put in place by Velopack
 * the next time the app starts.
 */
export class Updates {
    private current: UpdateStatus;
    /** Downloaded and waiting for a restart, from the channel it was found on. */
    private pending: { info: UpdateInfo; channel: UpdateChannel; updates: UpdateManager } | null = null;
    private checking: Promise<UpdateStatus> | null = null;

    constructor(
        private readonly host: UpdateHost,
        private readonly changed: () => void,
    ) {
        const channel = getSettings().updateChannel;
        const why = Updates.unavailable(channel);
        this.current = {
            version: app.getVersion(),
            channel,
            state: why ? 'unavailable' : 'idle',
            detail: why ?? undefined
        };
    }

    /** Why this copy cannot update itself, or null when it can. */
    private static unavailable(channel: UpdateChannel): string | null {
        if (!app.isPackaged) return 'This copy runs from source. Releases update themselves; this one updates with git.';
        if (!platformChannel()) return 'There are no releases for this platform.';
        try {
            manager(channel);
            return null;
        } catch {
            return 'This copy was not unpacked from a release zip, so it cannot update itself.';
        }
    }

    status(): UpdateStatus {
        return this.current;
    }

    /** Checks soon after launch, then every few hours. */
    start(): void {
        if (this.current.state === 'unavailable') return;
        setTimeout(() => void this.check(), FIRST_CHECK_MS).unref();
        setInterval(() => void this.check(), CHECK_EVERY_MS).unref();
    }

    /** Asked for by Check now as well as on the timer; a check already under way is shared. */
    check(): Promise<UpdateStatus> {
        if (this.current.state === 'unavailable') return Promise.resolve(this.current);
        this.checking ??= this.run().finally(() => {
            this.checking = null;
        });
        return this.checking;
    }

    /**
     * The channel setting changed: what was found on the old one is dropped, and the new one asked at once.
     * A copy that cannot update still shows the channel chosen.
     */
    channelChanged(): void {
        this.set({ channel: getSettings().updateChannel });
        if (this.current.state !== 'unavailable') void this.check();
    }

    /** Quits, and Velopack puts the waiting version in place and starts it. */
    restart(): void {
        if (!this.pending) throw new Error('No update is waiting. Check for one first.');
        if (this.host.busy()) throw new Error('A run is under way. Restart once it has finished, or cancel it first.');
        // Carried across, so a copy started on a test folder of its own comes back to it.
        const keep = process.argv.slice(1).filter((arg) => arg.startsWith('--user-data-dir='));
        this.pending.updates.waitExitThenApplyUpdate(this.pending.info, false, true, keep);
        log.info('app', `Restarting into Patchbay ${this.pending.info.TargetFullRelease.Version}`);
        app.quit();
    }

    private set(partial: Partial<UpdateStatus>): void {
        this.current = { ...this.current, ...partial };
        this.changed();
    }

    private async run(): Promise<UpdateStatus> {
        const channel = getSettings().updateChannel;
        // One is waiting already, from the channel still chosen: nothing to look for until it is used.
        if (this.pending?.channel === channel) return this.current;
        this.pending = null;
        this.set({ channel, state: 'checking', available: undefined, progress: undefined, detail: undefined });
        try {
            const updates = manager(channel);
            const info = await updates.checkForUpdatesAsync();
            if (!info) {
                this.set({ state: 'current', checkedAt: new Date().toISOString() });
                return this.current;
            }
            const version = info.TargetFullRelease.Version;
            const deltas = info.DeltasToTarget.length;
            log.info('app', `Downloading Patchbay ${version}`, {
                detail: deltas > 0 ? `${deltas} delta package(s)` : 'the full package',
            });
            this.set({ state: 'downloading', available: version, progress: 0, checkedAt: new Date().toISOString() });
            await updates.downloadUpdateAsync(info, (progress) => {
                if (progress !== this.current.progress) this.set({ progress });
            });
            // Switched channel while it came down: it is no longer the one wanted.
            if (getSettings().updateChannel !== channel) return this.run();
            this.pending = { info, channel, updates };
            log.info('app', `Patchbay ${version} is ready. Restart to use it, or it goes in next time Patchbay starts.`);
            this.set({ state: 'ready', progress: undefined });
        } catch (e) {
            log.warn('app', 'Could not check for updates', { detail: message(e) });
            this.set({
                state: 'failed',
                available: undefined,
                progress: undefined,
                detail: message(e),
                checkedAt: new Date().toISOString()
            });
        }
        return this.current;
    }
}

/**
 * A Mac app opened where it was downloaded runs from a read-only copy macOS makes
 * of it, which cannot update itself. Asked each launch until it has moved.
 */
export async function offerApplicationsFolder(): Promise<void> {
    if (process.platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder()) return;
    const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Move to Applications', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        message: 'Move Patchbay to your Applications folder?',
        detail: 'Patchbay can only update itself from there. It starts again once it has moved.',
    });
    if (response !== 0) return;
    try {
        app.moveToApplicationsFolder();
    } catch (e) {
        log.warn('app', 'Could not move Patchbay to Applications', { detail: message(e) });
    }
}
