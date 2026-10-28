import { existsSync, type FSWatcher, watch } from 'node:fs';
import { join } from 'node:path';
import { currentWorkspace } from '../paths';
import type { WorkspaceChange } from '@shared/ipc';

/**
 * Skills, schemas and MCP server files are edited and deleted outside the app,
 * so the open workspace's folders of them are watched, and a change is passed
 * on once it settles, saying which of them it was in.
 */

interface Target {
    recursive: boolean;
    change: WorkspaceChange;

    /** Whether a file event in this folder is one to pass on; absent means every event is. */
    filter?(name: string): boolean;
}

/** The folders watched inside a workspace, and what a change in each one is. */
const FOLDERS: { name: string; target: Target }[] = [
    {name: 'skills', target: {recursive: true, change: {flows: false, skills: true, schemas: false}}},
    {name: 'schemas', target: {recursive: true, change: {flows: false, skills: false, schemas: true}}},
    {
        name: '',
        target: {
            recursive: false,
            change: {flows: false, skills: false, schemas: false, mcp: true},
            filter: (name) =>
                name.startsWith('.mcp.json') || name === '.vscode' || name === '.cursor' || name === '.gemini',
        },
    },
    {
        name: '.vscode',
        target: {
            recursive: false,
            change: {flows: false, skills: false, schemas: false, mcp: true},
            filter: (name) => name.startsWith('mcp.json'),
        },
    },
    {
        name: '.cursor',
        target: {
            recursive: false,
            change: {flows: false, skills: false, schemas: false, mcp: true},
            filter: (name) => name.startsWith('mcp.json'),
        },
    },
    {
        name: '.gemini',
        target: {
            recursive: false,
            change: {flows: false, skills: false, schemas: false, mcp: true},
            filter: (name) => name.startsWith('settings.json'),
        },
    },
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
            rewatch();
            onChange?.(change);
        }, SETTLE_MS),
    );
}

/**
 * What to watch: the open workspace's `skills` and `schemas` folders, and the
 * top of the workspace and `.vscode`, `.cursor` and `.gemini` without descending
 * into anything else — watching the whole workspace recursively could mean a
 * repository's `node_modules`.
 */
function roots(): Map<string, Target> {
    const root = currentWorkspace();
    return new Map(root ? FOLDERS.map(({name, target}) => [name ? join(root, name) : root, target]) : []);
}

/** Start watching, and call `listener` whenever a skill, schema or MCP server file may have changed on disk. */
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
    for (const [path, target] of wanted) {
        if (watchers.has(path) || !existsSync(path)) continue;
        try {
            // Not persistent: a watch is no reason to keep the process alive.
            const watcher = watch(path, {recursive: target.recursive, persistent: false}, (_event, filename) => {
                const name = typeof filename === 'string' ? filename : '';
                if (name === 'skills' || name === 'schemas') rewatch();
                if (!target.filter || !name || target.filter(name)) changed(path, target.change);
            });
            // The folder went, or the drive did. Unhandled, this would throw in main.
            watcher.on('error', () => {
                watcher.close();
                if (watchers.get(path) === watcher) watchers.delete(path);
                changed(path, target.change);
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
