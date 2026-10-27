import { existsSync, type FSWatcher, watch } from 'node:fs';
import { join } from 'node:path';
import { currentWorkspace } from '../paths';
import type { WorkspaceChange } from '@shared/ipc';

/**
 * Skills and schemas are edited and deleted outside the app, so the open
 * workspace's folders of them are watched, and a change is passed on once it
 * settles, saying which of the two it was in.
 */

/** The folders watched, and what a change in each one is. */
const FOLDERS: { name: string; change: WorkspaceChange }[] = [
    {name: 'skills', change: {flows: false, skills: true, schemas: false}},
    {name: 'schemas', change: {flows: false, skills: false, schemas: true}},
];

/** An editor's save is several events — a temp file, a rename — and one re-read covers them. */
const SETTLE_MS = 250;

const watchers = new Map<string, FSWatcher>();
let onChange: ((change: WorkspaceChange) => void) | null = null;
/** Per folder, so a skill saved just after a schema still says so. */
const settling = new Map<string, NodeJS.Timeout>();

function changed(path: string, change: WorkspaceChange): void {
    clearTimeout(settling.get(path));
    settling.set(
        path,
        setTimeout(() => {
            settling.delete(path);
            onChange?.(change);
        }, SETTLE_MS),
    );
}

/**
 * What to watch: the open workspace's `skills` and `schemas` folders alone.
 * Watching the workspace as a whole could mean a repository's `node_modules`.
 */
function roots(): Map<string, WorkspaceChange> {
    const root = currentWorkspace();
    return new Map(root ? FOLDERS.map(({name, change}) => [join(root, name), change]) : []);
}

/** Start watching, and call `listener` whenever a skill or a schema may have changed on disk. */
export function watchFolders(listener: (change: WorkspaceChange) => void): void {
    onChange = listener;
    rewatch();
}

/**
 * Bring the watchers in line with the folders: drop one for a workspace no longer
 * open or a folder no longer there, and start one on a folder that is — made
 * since, say. Cheap when nothing moved, so every listing calls it.
 */
export function rewatch(): void {
    if (!onChange) return;
    const wanted = roots();
    for (const [path, watcher] of watchers) {
        if (wanted.has(path) && existsSync(path)) continue;
        watcher.close();
        watchers.delete(path);
    }
    for (const [path, change] of wanted) {
        if (watchers.has(path) || !existsSync(path)) continue;
        try {
            // Not persistent: a watch is no reason to keep the process alive.
            const watcher = watch(path, {recursive: true, persistent: false}, () => changed(path, change));
            // The folder went, or the drive did. Unhandled, this would throw in main.
            watcher.on('error', () => {
                watcher.close();
                if (watchers.get(path) === watcher) watchers.delete(path);
                changed(path, change);
            });
            watchers.set(path, watcher);
        } catch {
            // Unwatchable, such as a share that does not report changes. The windows
            // still re-read on focus, and the next listing tries again.
        }
    }
}

export function stopWatchingFolders(): void {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    for (const timer of settling.values()) clearTimeout(timer);
    settling.clear();
    onChange = null;
}
