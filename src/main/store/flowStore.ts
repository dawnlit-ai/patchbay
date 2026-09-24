import { cpSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    FLOW_FILE,
    flowDir,
    flowDirAt,
    flowDirNamed,
    flowFile,
    flowFolder,
    flowsDir,
    flowSkillsDir,
    forgetFlowFolders,
    watermarkFile,
} from '../paths';
import { readJson, writeJson } from './jsonFile';
import { getSkill, isValidSkillName, saveSkill } from './skillStore';
import { emptyFlow, type Flow, parseFlow } from '@shared/flow';
import { toFolderName } from '@shared/naming';
import type { FlowEntry, SaveOutcome } from '@shared/ipc';
import type { SkillScope } from '@shared/settings';

/**
 * A flow is a directory: `flows/<folder>/flow.json` beside the flow's own
 * `.claude/skills`, and the cwd its Processors run in. The folder can be renamed;
 * the id inside the file cannot, since runs and watermarks are keyed by it.
 */

export function listFlows(): Flow[] {
    const dir = flowsDir();
    const byId = new Map<string, Flow>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const flow = readJson<Flow | null>(join(dir, entry.name, FLOW_FILE), null);
        // A copied directory carries the same id; keep the first, as `flowFolder` does.
        if (flow && !byId.has(flow.id)) byId.set(flow.id, flow);
    }
    return [...byId.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

export function getFlow(id: string): Flow | null {
    // Not through flowFile, which makes the directory it names: asking after a
    // flow that was deleted, or never was, should not leave a folder behind.
    return readJson<Flow | null>(join(flowDirAt(flowFolder(id)), FLOW_FILE), null);
}

export function saveFlow(flow: Flow): Flow {
    // Strictly later than what it replaces. updatedAt is the version a canvas saves
    // against, so two writes landing in one millisecond must not share one.
    const previous = Date.parse(getFlow(flow.id)?.updatedAt ?? '');
    const stamp = Number.isNaN(previous) ? Date.now() : Math.max(Date.now(), previous + 1);
    const next: Flow = { ...flow, updatedAt: new Date(stamp).toISOString() };
    writeJson(flowFile(next.id), next);
    return next;
}

// ── Saving over someone else's write ─────────────────────────────────────

/**
 * Per writer (one per window): `<flowId>@<version it sent>` → the version its save
 * produced. A canvas keeps sending the version it last read, so this is how its
 * own saves are told apart from somebody else's.
 */
const lineage = new Map<string, Map<string, string>>();

/**
 * Save an edit made to the version `flow.updatedAt` names, unless something else
 * has written the flow since. Then nothing is written and the caller gets the
 * current flow (null once deleted) instead.
 */
export function saveFlowFrom(writer: string, flow: Flow): SaveOutcome {
    const mine = lineage.get(writer) ?? new Map<string, string>();
    lineage.set(writer, mine);
    const key = `${flow.id}@${flow.updatedAt}`;
    const current = getFlow(flow.id);
    if (!current || current.updatedAt !== (mine.get(key) ?? flow.updatedAt)) return { current };
    const saved = saveFlow(flow);
    mine.set(key, saved.updatedAt);
    return { saved };
}

/** A window closed: nothing it sent will be resolved again. */
export function forgetWriter(writer: string): void {
    lineage.delete(writer);
}

/** Rename a flow. Separate from a save, because other windows are told about a rename. */
export function renameFlow(id: string, name: string): Flow {
    const flow = getFlow(id);
    if (!flow) throw new Error('That flow is no longer in the workspace.');
    return saveFlow({ ...flow, name });
}

// ── Where a flow lives ───────────────────────────────────────────────────

/** A flow with the directory it sits in — what the welcome window lists. */
export function entryFor(flow: Flow): FlowEntry {
    const folder = flowFolder(flow.id);
    return { flow, folder, path: flowDirAt(folder) };
}

export function listFlowEntries(): FlowEntry[] {
    return listFlows().map(entryFor);
}

export function flowLocation(flowId: string): string {
    return flowDir(flowId);
}

/** Folder names, lowercased: two of the three filesystems we run on ignore case. */
function takenFolders(): Set<string> {
    return new Set(
        readdirSync(flowsDir(), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name.toLowerCase()),
    );
}

/** That name, or the first numbered variant of it no directory already holds. */
function freeFolder(wanted: string, except?: string): string {
    const taken = takenFolders();
    if (except) taken.delete(except.toLowerCase());
    let name = wanted;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted}-${n}`;
    return name;
}

/** Write a new flow into a fresh directory named after it. Every new, copied and imported flow comes through here. */
function createIn(flow: Flow, folderFrom: string): Flow {
    const dir = flowDirNamed(freeFolder(toFolderName(folderFrom)));
    const next: Flow = { ...flow, updatedAt: new Date().toISOString() };
    writeJson(join(dir, FLOW_FILE), next);
    forgetFlowFolders();
    return next;
}

/** Rename a flow's directory. Its id, and everything keyed by it, is untouched. */
export function setFlowFolder(flowId: string, requested: string): FlowEntry {
    const flow = getFlow(flowId);
    if (!flow) throw new Error('That flow is no longer in the workspace.');
    const current = flowFolder(flowId);
    const wanted = toFolderName(requested);
    if (wanted !== current) {
        if (freeFolder(wanted, current) !== wanted) {
            throw new Error(`Another flow's folder is already called “${wanted}”.`);
        }
        renameSync(flowDir(flowId), flowDirAt(wanted));
        forgetFlowFolders();
    }
    return entryFor(flow);
}

// ── Making and unmaking ──────────────────────────────────────────────────

export function createFlow(name: string): Flow {
    // Its own library starts empty: the global one is already on the shelf, and a
    // flow-specific skill is something you decide to write, not inherit.
    return createIn(emptyFlow(randomUUID(), name), name);
}

/**
 * Copy the graph handed over (what is on screen, unsaved edits included) into a
 * new flow, along with its own skill library. Node ids are kept, as they only need
 * to be unique within a flow; watermarks are not.
 */
export function duplicateFlow(source: Flow, name: string): Flow {
    const copy = createIn({ ...source, id: randomUUID(), name }, name);
    cpSync(flowSkillsDir(source.id), flowSkillsDir(copy.id), { recursive: true });
    return copy;
}

/** Takes the flow's directory — its own skills and all — and the watcher's mark. */
export function removeFlow(id: string): void {
    rmSync(flowDir(id), { recursive: true, force: true });
    forgetFlowFolders();
    // Drop its watermarks, one per trigger, keyed `<flowId>:<nodeId>`.
    const marks = readJson<Record<string, unknown>>(watermarkFile(), {});
    const mine = Object.keys(marks).filter((key) => key.startsWith(`${id}:`));
    if (mine.length > 0) {
        for (const key of mine) delete marks[key];
        writeJson(watermarkFile(), marks);
    }
}

// ── Files outside the workspace ──────────────────────────────────────────

/** What a flow file may carry beside the graph, so it can be run elsewhere. */
interface BundledSkill {
    name: string;
    scope: SkillScope;
    content: string;
}

function bundledSkills(raw: unknown): BundledSkill[] {
    const list = (raw as { skills?: unknown }).skills;
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry): BundledSkill[] => {
        const { name, scope, content } = (entry ?? {}) as {
            name?: unknown;
            scope?: unknown;
            content?: unknown;
        };
        if (typeof name !== 'string' || typeof content !== 'string') return [];
        if (!isValidSkillName(name)) return [];
        return [{ name, scope: scope === 'global' ? 'global' : 'flow', content }];
    });
}

/**
 * Import a flow file as a new flow, never over an existing one. The graph goes
 * through `parseFlow`, and any skills the file carries fill the new library.
 */
export function importFlowFile(path: string): Flow {
    const label = basename(path);
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        throw new Error(`${label} is not readable JSON.`);
    }
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { nodes?: unknown }).nodes)) {
        throw new Error(`${label} does not look like a Patchbay flow.`);
    }
    const parsed = parseFlow(raw, randomUUID(), label.replace(/\.json$/i, '') || 'Imported flow');
    const flow = createIn(parsed, parsed.name);

    for (const skill of bundledSkills(raw)) {
        // Never overwrite an existing global skill: other flows use it.
        if (skill.scope === 'global' && getSkill('global', '', skill.name)) continue;
        saveSkill(skill.scope, flow.id, skill.name, skill.content);
    }
    return flow;
}
