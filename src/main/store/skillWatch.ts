import { existsSync, type FSWatcher, watch } from 'node:fs';
import { join } from 'node:path';
import { currentWorkspace } from '../paths';

/**
 * Skills are edited and deleted outside the app, so the open workspace's library
 * is watched and a change is passed on once it settles.
 */

/** An editor's save is several events — a temp file, a rename — and one re-read covers them. */
const SETTLE_MS = 250;

const watchers = new Map<string, FSWatcher>();
let onChange: (() => void) | null = null;
let settle: NodeJS.Timeout | null = null;

function changed(): void {
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
        settle = null;
        onChange?.();
    }, SETTLE_MS);
}

/**
 * What to watch: the open workspace's `skills` folder alone. Watching the
 * workspace as a whole could mean a repository's `node_modules`.
 */
function roots(): string[] {
    const root = currentWorkspace();
    return root ? [join(root, 'skills')] : [];
}

/** Start watching, and call `listener` whenever a skill may have changed on disk. */
export function watchSkills(listener: () => void): void {
    onChange = listener;
    rewatch();
}

/**
 * Bring the watcher in line with the library: drop it for a workspace no longer
 * open or a folder no longer there, and start one on a folder that is — made
 * since, say. Cheap when nothing moved, so every listing calls it.
 */
export function rewatch(): void {
    if (!onChange) return;
    const wanted = roots();
    for (const [path, watcher] of watchers) {
        if (wanted.includes(path) && existsSync(path)) continue;
        watcher.close();
        watchers.delete(path);
    }
    for (const path of wanted) {
        if (watchers.has(path) || !existsSync(path)) continue;
        try {
            // Not persistent: a watch is no reason to keep the process alive.
            const watcher = watch(path, {recursive: true, persistent: false}, changed);
            // The folder went, or the drive did. Unhandled, this would throw in main.
            watcher.on('error', () => {
                watcher.close();
                if (watchers.get(path) === watcher) watchers.delete(path);
                changed();
            });
            watchers.set(path, watcher);
        } catch {
            // Unwatchable, such as a share that does not report changes. The windows
            // still re-read on focus, and the next listing tries again.
        }
    }
}

export function stopWatchingSkills(): void {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    if (settle) clearTimeout(settle);
    settle = null;
    onChange = null;
}
