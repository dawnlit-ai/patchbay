import { app } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readJson, writeJson } from './store/jsonFile';
import { toFolderName } from '@shared/naming';

/**
 * Two roots. The app's own data — settings, runs, logs, watermarks — lives under
 * userData. A workspace is a folder of the user's: its flows in `flows/`, the
 * skills they share in `skills/` and the schemas in `schemas/`, and it is the
 * directory every run of them works in. One is open at a time.
 */
let data: string | null = null;

/** Where the app keeps its own files in `<userData>`: settings, workspaces, watermarks, runs and logs. */
export function dataRoot(): string {
    if (!data) {
        data = join(app.getPath('userData'), 'workspace');
        mkdirSync(data, {recursive: true});
    }
    return data;
}

function ensureAt(path: string): string {
    mkdirSync(path, {recursive: true});
    return path;
}

function ensure(...segments: string[]): string {
    return ensureAt(join(dataRoot(), ...segments));
}

export const isSafeSegment = (name: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);

/** Refuses a name that could climb out of its folder: these come from the renderer and can reach `rm`. */
function safeSegment(name: string): string {
    if (!isSafeSegment(name)) throw new Error(`"${name}" is not a usable file name.`);
    return name;
}

/** A path as a key, the same however its case or a trailing separator is written: two of the three filesystems we run on ignore case. */
export const pathKey = (path: string): string =>
    process.platform === 'linux' ? resolve(path) : resolve(path).toLowerCase();

export const samePath = (a: string, b: string): boolean => pathKey(a) === pathKey(b);

// ── Which workspace is open ──────────────────────────────────────────────

/** The workspace open now, those opened before (last first), and where New workspace last made one. */
export interface WorkspaceState {
    current: string;
    recent: string[];
    location: string;
}

const workspacesFile = (): string => join(dataRoot(), 'workspaces.json');

let state: WorkspaceState | null = null;

export function workspaceState(): WorkspaceState {
    if (state) return state;
    const raw = readJson<Partial<Record<keyof WorkspaceState, unknown>>>(workspacesFile(), {});
    const recent = Array.isArray(raw.recent) ? raw.recent : [];
    state = {
        current: typeof raw.current === 'string' ? raw.current : '',
        recent: recent.filter((path): path is string => typeof path === 'string'),
        location: typeof raw.location === 'string' ? raw.location : '',
    };
    return state;
}

export function setWorkspaceState(next: WorkspaceState): void {
    state = next;
    writeJson(workspacesFile(), next);
    forgetFlowHomes();
}

export function isFolder(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** The open workspace's folder, or null when none is open or its folder has gone. */
export function currentWorkspace(): string | null {
    const {current} = workspaceState();
    return current && isFolder(current) ? current : null;
}

/** The open workspace's folder. Everything that reads or writes flows and skills goes through here. */
export function workspaceRoot(): string {
    const root = currentWorkspace();
    if (!root) throw new Error('No workspace is open. Open or create one from the start window.');
    return root;
}

/** Where the workspace's flow files are. Does not create it: for reading. */
export const flowsDirAt = (): string => join(workspaceRoot(), 'flows');
/** That folder, made if missing, for writing. */
export const flowsDir = (): string => ensureAt(flowsDirAt());
/** Where the workspace's `<name>/SKILL.md` folders are. Does not create it: for reading. */
export const skillsDirAt = (): string => join(workspaceRoot(), 'skills');
export const skillsDir = (): string => ensureAt(skillsDirAt());
/** Where the workspace's named schemas are, a `<name>.json` each. Does not create it: for reading. */
export const schemasDirAt = (): string => join(workspaceRoot(), 'schemas');
export const schemasDir = (): string => ensureAt(schemasDirAt());

// ── Where each flow is ───────────────────────────────────────────────────

/**
 * Flow id → its file. The user can rename or copy a file, so its name cannot be
 * the id. Rebuilt on a miss, and dropped by whatever adds, renames or removes one.
 */
let homes: Map<string, string> | null = null;

function readId(file: string): string | null {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown; nodes?: unknown };
        // An id names a file when its own goes missing, so it has to be fit to.
        return typeof raw.id === 'string' && isSafeSegment(raw.id) && Array.isArray(raw.nodes) ? raw.id : null;
    } catch {
        // Not a flow file, or not readable. Nothing here can fix either.
        return null;
    }
}

function scanHomes(): Map<string, string> {
    const found = new Map<string, string>();
    const root = currentWorkspace();
    if (!root) return found;
    const dir = join(root, 'flows');
    let names: string[];
    try {
        names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json')).sort();
    } catch {
        return found;
    }
    for (const name of names) {
        const file = join(dir, name);
        const id = readId(file);
        // A copied file carries the same id; the first one found wins.
        if (id !== null && !found.has(id)) found.set(id, file);
    }
    return found;
}

/** Every flow in the open workspace, read from disk afresh. */
export function flowHomes(): Map<string, string> {
    homes = scanHomes();
    return homes;
}

/** Where a flow's file is. The cache is checked against disk, since the user can move files too. */
export function flowFile(flowId: string): string {
    const cached = homes?.get(flowId);
    if (cached && existsSync(cached)) return cached;
    // An id with no file is one about to be given one, such as a test run's flow
    // built in memory. Its own id names the file.
    return flowHomes().get(flowId) ?? join(flowsDirAt(), `${safeSegment(flowId)}.json`);
}

/** Called by whatever creates, renames or removes a flow file. */
export function forgetFlowHomes(): void {
    homes = null;
}

/** Where a flow file of that name would sit in the workspace. Does not create it. */
export const flowFileNamed = (name: string): string => join(flowsDirAt(), `${safeSegment(name)}.json`);

// ── The app's own data ───────────────────────────────────────────────────

/** The open workspace as a file name: its folder's name and a hash of its path, so two of one name stay apart. */
function workspaceKey(): string {
    const root = workspaceRoot();
    const tag = createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 8);
    return `${toFolderName(basename(root), 'workspace')}-${tag}`;
}

/**
 * Each workspace's runs are kept apart, in a folder named for it, so the runs
 * panel shows the open one's. They stay in the app's data rather than the
 * workspace: a trace holds the mail it handled, and a workspace may be a git
 * repository.
 */
export const runsDir = (): string => ensure('runs', workspaceKey());
/**
 * The replies each workspace's Create email nodes drafted, one JSONL file a workspace.
 * Beside its runs rather than among them, so clearing the runs does not forget
 * which emails already have a reply.
 */
export const repliesFile = (): string => join(ensure('replies'), `${workspaceKey()}.jsonl`);
/**
 * The drafts each workspace's Send nodes sent, one JSONL file a workspace, kept
 * beside the replies for the same reason: clearing the runs must not forget them.
 */
export const sendsFile = (): string => join(ensure('sends'), `${workspaceKey()}.jsonl`);
/** Where a run's scratch space is, without making it: for a run that may have saved nothing. */
export const runFilesDir = (runId: string): string => join(runsDir(), safeSegment(runId) + '.files');
/** Per-run scratch space — saved attachments, files a skill writes. */
export const runScratchDir = (runId: string): string => ensureAt(runFilesDir(runId));
export const settingsFile = (): string => join(dataRoot(), 'settings.json');
/**
 * Which servers found in each workspace's files have been allowed here. Kept in
 * the app's data, not the workspace: a file that could allow itself would not be asked about.
 */
export const mcpTrustFile = (): string => join(dataRoot(), 'mcp-trust.json');
/**
 * The values set for each workspace's servers, encrypted. In the app's data for
 * the same reason, and so a token never lands in a folder that gets committed.
 */
export const mcpSecretsFile = (): string => join(dataRoot(), 'mcp-secrets.json');
/** The API keys of the agents reached with one, sealed: see keyStore. */
export const agentKeysFile = (): string => join(dataRoot(), 'agent-keys.json');
/**
 * Which emails each workspace's triggers have seen, a file a workspace. A poll
 * drops the marks of triggers no longer in the open workspace, so one file shared
 * by every workspace would lose the others' marks whenever one was polled.
 */
export const watermarkFile = (): string => join(ensure('watermarks'), `${workspaceKey()}.json`);
/** The one file every workspace's marks were kept in before each had its own: read only to carry them over. */
export const sharedWatermarkFile = (): string => join(dataRoot(), 'watermarks.json');
export const runIndexFile = (): string => join(runsDir(), 'index.jsonl');
/**
 * The AI monitor's reviews, one JSON line a run, among the runs: they quote the
 * mail they reviewed, and go when the runs are cleared.
 */
export const monitorLogFile = (): string => join(runsDir(), 'monitor.jsonl');
/** The console's files, one JSONL per day. */
export const logsDir = (): string => ensure('logs');
