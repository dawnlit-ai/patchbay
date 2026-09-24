import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Everything lives under one workspace directory. Each flow has its own directory
 * in it, which is the Agent SDK `cwd` its `.claude/skills` are found from.
 */
let root: string | null = null;

export function workspaceRoot(): string {
    if (!root) {
        root = join(app.getPath('userData'), 'workspace');
        mkdirSync(root, { recursive: true });
    }
    return root;
}

function ensureAt(path: string): string {
    mkdirSync(path, { recursive: true });
    return path;
}

function ensure(...segments: string[]): string {
    return ensureAt(join(workspaceRoot(), ...segments));
}

/** Refuses a name that could climb out of the workspace: these come from the renderer and can reach `rm -r`. */
function safeSegment(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`"${name}" is not a usable folder name.`);
    return name;
}

/** The global library, in plugin layout (manifest beside `skills/`) so runs can load it from outside their cwd. */
export const globalPluginDir = (): string => ensure('global');
export const globalSkillsDir = (): string => ensure('global', 'skills');

export const flowsDir = (): string => ensure('flows');

/** A flow's directory holds its graph under this name, whatever it is called. */
export const FLOW_FILE = 'flow.json';

/**
 * Flow id → directory name. The user can rename the directory, so it cannot be
 * the id. Rebuilt on a miss, and dropped by whatever moves a directory.
 */
let folders: Map<string, string> | null = null;

function scanFolders(): Map<string, string> {
    const dir = flowsDir();
    const found = new Map<string, string>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
            const raw: unknown = JSON.parse(readFileSync(join(dir, entry.name, FLOW_FILE), 'utf8'));
            const id = (raw as { id?: unknown }).id;
            // A copied directory carries the same id; the first one found wins.
            if (typeof id === 'string' && !found.has(id)) found.set(id, entry.name);
        } catch {
            // Not a flow directory, or not readable. Nothing here can fix either.
        }
    }
    return found;
}

/** A flow's directory name. The cache is checked against disk, since the user can move directories too. */
export function flowFolder(flowId: string): string {
    const cached = folders?.get(flowId);
    if (cached && existsSync(join(flowsDir(), cached, FLOW_FILE))) return cached;
    folders = scanFolders();
    // An id with no directory is one about to be given one — a flow mid-creation,
    // or a test run built in memory. Its own id names the directory.
    return folders.get(flowId) ?? flowId;
}

/** Called by whatever creates, renames or removes a flow directory. */
export function forgetFlowFolders(): void {
    folders = null;
}

/** Where a directory of that name would sit. Does not create it. */
export const flowDirAt = (folder: string): string => join(flowsDir(), safeSegment(folder));

/** That directory, made if it is not there yet. */
export const flowDirNamed = (folder: string): string => ensureAt(flowDirAt(folder));

/** A flow's directory, created if missing: it is its runs' cwd, which the Agent SDK needs to exist. */
export const flowDir = (flowId: string): string => flowDirNamed(flowFolder(flowId));
export const flowFile = (flowId: string): string => join(flowDir(flowId), FLOW_FILE);
/** Where one flow's SKILL.md folders would sit. Does not create it: for reading. */
export const flowSkillsDirAt = (flowId: string): string =>
    join(flowDirAt(flowFolder(flowId)), '.claude', 'skills');
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
