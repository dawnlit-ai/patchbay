import { existsSync, type FSWatcher, watch } from 'node:fs';
import { flowsDir, globalSkillsDir } from '../paths';
import { getSettings } from './settingsStore';

/**
 * Skills are written in the user's own editor and deleted from the file manager,
 * so the folders holding them are watched while the app runs, and a change under
 * any of them is passed on once it settles. The windows re-read the list on it.
 */

/** An editor's save is several events — a temp file, a rename — and one re-read covers them. */
const SETTLE_MS = 250;

interface Root {
    path: string;

    /** Whether a change to this file, relative to the root, is one to a skill. */
    concerns(file: string): boolean;
}

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
 * What to watch. `flows` as a whole rather than each flow's library, which comes
 * and goes with the flow and its first skill — and on Windows, a folder holding a
 * watched one cannot be renamed, as a flow's folder is. Its graph and whatever its
 * runs write change there too; only what is under a `.claude` counts.
 */
function roots(): Root[] {
    const everything = (): boolean => true;
    return [
        ...getSettings().globalSkillFolders.map((path) => ({ path, concerns: everything })),
        { path: globalSkillsDir(), concerns: everything },
        { path: flowsDir(), concerns: (file: string) => file.split(/[\\/]/).includes('.claude') },
    ];
}

/** Start watching, and call `listener` whenever a skill may have changed on disk. */
export function watchSkills(listener: () => void): void {
    onChange = listener;
    rewatch();
}

/**
 * Bring the watchers in line with the folders the libraries read: drop one no
 * longer linked or no longer there, and start one on a folder that is — a drive
 * plugged back in, say. Cheap when nothing moved, so every listing calls it.
 */
export function rewatch(): void {
    if (!onChange) return;
    const wanted = roots();
    for (const [path, watcher] of watchers) {
        if (wanted.some((root) => root.path === path) && existsSync(path)) continue;
        watcher.close();
        watchers.delete(path);
    }
    for (const { path, concerns } of wanted) {
        if (watchers.has(path) || !existsSync(path)) continue;
        try {
            // Not persistent: a watch is no reason to keep the process alive.
            const watcher = watch(path, { recursive: true, persistent: false }, (_event, file) => {
                // Some platforms leave the name out; a spare re-read is harmless.
                if (!file || concerns(file)) changed();
            });
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
