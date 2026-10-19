import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readJson, writeJson } from './store/jsonFile';

/**
 * Everything lives under one workspace directory, except flow files opened from
 * elsewhere, which stay where they are. A flow's directory is the Agent SDK `cwd`
 * its `.claude/skills` are found from.
 */
let root: string | null = null;

export function workspaceRoot(): string {
    if (!root) {
        root = join(app.getPath('userData'), 'workspace');
        mkdirSync(root, {recursive: true});
    }
    return root;
}

function ensureAt(path: string): string {
    mkdirSync(path, {recursive: true});
    return path;
}

function ensure(...segments: string[]): string {
    return ensureAt(join(workspaceRoot(), ...segments));
}

export const isSafeSegment = (name: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);

/** Refuses a name that could climb out of the workspace: these come from the renderer and can reach `rm -r`. */
function safeSegment(name: string): string {
    if (!isSafeSegment(name)) throw new Error(`"${name}" is not a usable folder name.`);
    return name;
}

/** The global library, in plugin layout (manifest beside `skills/`) so runs can load it from outside their cwd. */
export const globalPluginDir = (): string => ensure('global');
export const globalSkillsDir = (): string => ensure('global', 'skills');

export const flowsDir = (): string => ensure('flows');

/** A flow's directory holds its graph under this name, whatever it is called. */
export const FLOW_FILE = 'flow.json';

/** Two of the three filesystems we run on ignore case. */
export function samePath(a: string, b: string): boolean {
    const fold = (path: string): string => (process.platform === 'linux' ? resolve(path) : resolve(path).toLowerCase());
    return fold(a) === fold(b);
}

export interface FlowHome {
    /** The flow's file. Its directory is the flow's directory. */
    file: string;
    /** Opened from elsewhere on disk. Its directory is the user's: the app never renames or deletes it. */
    inPlace: boolean;
}

/**
 * Flow id → its file. The user can rename a directory or move a file, so neither
 * can be the id. Rebuilt on a miss, and dropped by whatever moves a flow.
 */
let homes: Map<string, FlowHome> | null = null;

function readId(file: string): string | null {
    try {
        const id = (JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown }).id;
        // An id names a folder when its file goes missing, so it has to be fit to.
        return typeof id === 'string' && isSafeSegment(id) ? id : null;
    } catch {
        // Not a flow file, or not readable — a drive unplugged, say. Nothing here can fix either.
        return null;
    }
}

function scanHomes(): Map<string, FlowHome> {
    const dir = flowsDir();
    const found = new Map<string, FlowHome>();
    // A copied file carries the same id; the first one found wins.
    const add = (file: string, inPlace: boolean): void => {
        const id = readId(file);
        if (id !== null && !found.has(id)) found.set(id, {file, inPlace});
    };
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        if (entry.isDirectory()) add(join(dir, entry.name, FLOW_FILE), false);
    }
    for (const file of openedFlowFiles()) add(file, true);
    return found;
}

/** Every flow there is, read from disk afresh. */
export function flowHomes(): Map<string, FlowHome> {
    homes = scanHomes();
    return homes;
}

/** Where a flow's file is. The cache is checked against disk, since the user can move files too. */
export function flowHome(flowId: string): FlowHome {
    const cached = homes?.get(flowId);
    if (cached && existsSync(cached.file)) return cached;
    // An id with no file is one about to be given one — a flow mid-creation, or a
    // test run built in memory. Its own id names a directory in the workspace.
    return flowHomes().get(flowId) ?? {file: join(flowDirAt(flowId), FLOW_FILE), inPlace: false};
}

/** Called by whatever creates, renames or removes a flow directory. */
export function forgetFlowHomes(): void {
    homes = null;
}

/** Flow files opened from elsewhere, newest first: listed and saved where they are, never copied in. */
const openedFile = (): string => join(workspaceRoot(), 'opened-flows.json');

export function openedFlowFiles(): string[] {
    const list = readJson<unknown>(openedFile(), []);
    return Array.isArray(list) ? list.filter((file): file is string => typeof file === 'string') : [];
}

export function setOpenedFlowFiles(files: string[]): void {
    writeJson(openedFile(), files);
    forgetFlowHomes();
}

/** The skill libraries of flows opened in place, which `flows` does not hold. From the cache when there is one. */
export function openedFlowSkillDirs(): string[] {
    homes ??= scanHomes();
    return [...homes.values()]
        .filter((home) => home.inPlace)
        .map((home) => join(dirname(home.file), '.claude', 'skills'));
}

/** Where a directory of that name would sit in the workspace. Does not create it. */
export const flowDirAt = (folder: string): string => join(flowsDir(), safeSegment(folder));

/** That directory, made if it is not there yet. */
export const flowDirNamed = (folder: string): string => ensureAt(flowDirAt(folder));

/** Makes a workspace flow's directory. One opened in place is not the app's to make, even when it has gone. */
function made(home: FlowHome): FlowHome {
    if (!home.inPlace) ensureAt(dirname(home.file));
    return home;
}

/** A flow's directory, created if missing: it is its runs' cwd, which the Agent SDK needs to exist. */
export const flowDir = (flowId: string): string => dirname(made(flowHome(flowId)).file);
export const flowFile = (flowId: string): string => made(flowHome(flowId)).file;
/** Where one flow's SKILL.md folders would sit. Does not create it: for reading. */
export const flowSkillsDirAt = (flowId: string): string =>
    join(dirname(flowHome(flowId).file), '.claude', 'skills');
/** Where one flow's SKILL.md folders live. The Agent SDK discovers them from here. */
export const flowSkillsDir = (flowId: string): string => ensureAt(flowSkillsDirAt(flowId));
export const runsDir = (): string => ensure('runs');
/** Per-run scratch space — saved attachments, files a skill writes. */
export const runScratchDir = (runId: string): string => ensure('runs', safeSegment(runId) + '.files');
export const settingsFile = (): string => join(workspaceRoot(), 'settings.json');
export const watermarkFile = (): string => join(workspaceRoot(), 'watermarks.json');
export const runIndexFile = (): string => join(runsDir(), 'index.jsonl');
/** The console's files, one JSONL per day. */
export const logsDir = (): string => ensure('logs');
