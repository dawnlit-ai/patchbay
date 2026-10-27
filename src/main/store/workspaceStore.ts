import { app } from 'electron';
import { mkdirSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { currentWorkspace, isFolder, samePath, setWorkspaceState, workspaceState } from '../paths';
import { seedStarterSkill } from './skillStore';
import { toFolderName } from '@shared/naming';
import type { WorkspaceInfo } from '@shared/ipc';

/**
 * Which folder is the open workspace, and the ones opened before it. A workspace
 * is any folder: the app reads `flows/` and `skills/` in it, and makes them only
 * when it first writes one.
 */

/** How many the start window remembers. */
const RECENT_LIMIT = 12;

const describe = (path: string): WorkspaceInfo => ({name: basename(path), path, missing: !isFolder(path)});

export function currentWorkspaceInfo(): WorkspaceInfo | null {
    const root = currentWorkspace();
    return root ? describe(root) : null;
}

export function recentWorkspaces(): WorkspaceInfo[] {
    return workspaceState().recent.map(describe);
}

export const isCurrentWorkspace = (path: string): boolean => {
    const root = currentWorkspace();
    return root !== null && samePath(root, path);
};

/** Make a folder the open workspace, first on the recent list. */
export function openWorkspace(path: string): WorkspaceInfo {
    if (!isAbsolute(path)) throw new Error(`"${path}" is not a full path. Choose the workspace's folder.`);
    const root = resolve(path);
    if (!isFolder(root)) throw new Error(`No such folder: ${root}. It was moved, renamed or deleted.`);
    const state = workspaceState();
    setWorkspaceState({
        ...state,
        current: root,
        recent: [root, ...state.recent.filter((p) => !samePath(p, root))].slice(0, RECENT_LIMIT),
    });
    return describe(root);
}

/** Take a workspace off the recent list. Its folder is untouched. */
export function forgetWorkspace(path: string): WorkspaceInfo[] {
    if (isCurrentWorkspace(path)) throw new Error('That is the workspace open now. Open another one first.');
    const state = workspaceState();
    setWorkspaceState({...state, recent: state.recent.filter((p) => !samePath(p, path))});
    return recentWorkspaces();
}

/** Where New workspace offers to put one: where the last one went, else a folder of the app's own in Documents. */
export function workspaceLocation(): string {
    return workspaceState().location || join(app.getPath('documents'), 'Patchbay');
}

/**
 * Make a folder named after it inside `location`, numbered past anything already
 * there so a new workspace never moves into someone's folder, give it a starter
 * skill, and open it.
 */
export function createWorkspace(name: string, location: string): WorkspaceInfo {
    if (!isAbsolute(location)) throw new Error(`"${location}" is not a full path. Choose a folder for the workspace.`);
    const parent = resolve(location);
    mkdirSync(parent, {recursive: true});
    const taken = new Set(readdirSync(parent).map((entry) => entry.toLowerCase()));
    const wanted = toFolderName(name, 'workspace');
    let folder = wanted;
    for (let n = 2; taken.has(folder.toLowerCase()); n++) folder = `${wanted}-${n}`;
    const root = join(parent, folder);
    mkdirSync(join(root, 'flows'), {recursive: true});
    const opened = openWorkspace(root);
    setWorkspaceState({...workspaceState(), location: parent});
    seedStarterSkill();
    return opened;
}
