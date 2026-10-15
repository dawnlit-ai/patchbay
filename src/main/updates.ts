import { app } from 'electron';
import { UpdateManager } from 'velopack';
import { log } from './log';

const FEED_FLAG = '--update-feed=';

/**
 * The portable-update test: started with `--update-feed=<folder or URL>`, a packed
 * copy checks that feed once, downloads what it finds and restarts into it. Without
 * the flag it does nothing; the real updater replaces it.
 */
export function runUpdateTest(): void {
    const feed = process.argv.find((arg) => arg.startsWith(FEED_FLAG))?.slice(FEED_FLAG.length);
    if (!feed) return;
    void (async () => {
        try {
            const updates = new UpdateManager(feed);
            log.info('app', `Update test: running ${updates.getCurrentVersion()}, portable ${updates.isPortable()}`, { detail: `feed: ${feed}` });
            const info = await updates.checkForUpdatesAsync();
            if (!info) {
                log.info('app', 'Update test: nothing newer on the feed');
                return;
            }
            const deltas = info.DeltasToTarget.length;
            log.info('app', `Update test: ${info.TargetFullRelease.Version} found, downloading`, { detail: deltas > 0 ? `${deltas} delta(s)` : 'full package' });
            await updates.downloadUpdateAsync(info);
            // The restart keeps the test's own user-data folder and drops the feed, so the new copy does not check again.
            const keep = process.argv.slice(1).filter((arg) => arg.startsWith('--user-data-dir='));
            log.info('app', 'Update test: downloaded, restarting into it');
            updates.waitExitThenApplyUpdate(info, true, true, keep);
            app.quit();
        } catch (error) {
            log.error('app', 'Update test: failed', { detail: error instanceof Error ? error.message : String(error) });
        }
    })();
}
