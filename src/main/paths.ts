import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Everything the app owns lives under one workspace directory, and every flow
 * owns a directory inside it: the Agent SDK needs a real `cwd` with a
 * `.claude/skills` tree beneath it, and that cwd is the flow being run.
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

/**
 * Run ids and folder names reach these from the renderer and become path
 * segments, so anything that could climb out of the workspace is refused here
 * rather than further down, where the call is an `rm -r`.
 */
function safeSegment(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`"${name}" is not a usable folder name.`);
    return name;
}

/**
 * The global library is handed to Claude as a local plugin, which is what lets a
 * run load skills from outside its own working directory. That layout is the
 * plugin one — a manifest beside a `skills` folder — rather than `.claude/skills`.
 */
export const globalPluginDir = (): string => ensure('global');
export const globalSkillsDir = (): string => ensure('global', 'skills');

export const flowsDir = (): string => ensure('flows');

/** A flow's directory holds its graph under this name, whatever it is called. */
export const FLOW_FILE = 'flow.json';

/**
 * Which directory holds which flow. The directory's name belongs to the user —
 * it is the project location the welcome window shows, and offers to change — so
 * it cannot also be the flow's identity: ids are minted once and then referred to
 * by every run, every watermark and every tool an agent calls. The map is rebuilt
 * whenever a lookup asks for something it does not hold, and dropped outright by
 * whatever moved a directory.
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
            // A directory copied in the file manager carries the id it was copied
            // from, so two may answer to one flow. The first found keeps it, and the
            // other is a directory the app simply never reads.
            if (typeof id === 'string' && !found.has(id)) found.set(id, entry.name);
        } catch {
            // Not a flow directory, or not readable. Nothing here can fix either.
        }
    }
    return found;
}

/**
 * The directory name a flow's files sit under. A cached answer is checked against
 * the disk before it is trusted, because the thing that moves a directory is
 * sometimes this app and sometimes the person using it.
 */
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

/**
 * A flow's own directory: its file, its skills, and the cwd every node of it runs
 * in. Created on the way out, because a cwd that does not exist is a run that
 * fails at the Agent SDK rather than at the call that forgot to make it.
 */
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
