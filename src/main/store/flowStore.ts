import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
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
    workspaceRoot,
} from '../paths';
import { readJson, writeJson } from './jsonFile';
import { getSkill, importSkillsFrom, isValidSkillName, listSkills, saveSkill } from './skillStore';
import { emptyFlow, type Flow, type FlowNode, parseFlow } from '@shared/flow';
import { toFolderName } from '@shared/naming';
import type { FlowEntry } from '@shared/ipc';
import { isGlobalRef, skillRef, type SkillScope } from '@shared/settings';

/**
 * A flow is a directory rather than a file: `flows/<folder>/flow.json` sits
 * beside the `.claude/skills` tree only this flow's Processors can reach, and
 * that directory is the cwd they run in. The global library is elsewhere and
 * shared, so nothing here touches it beyond what an export carries.
 *
 * The folder is named after the flow and can be renamed — it is what the welcome
 * window offers to open in the file manager. The flow's id is not: it is inside
 * the file, and runs and watermarks are keyed by it.
 */

export function listFlows(): Flow[] {
    const dir = flowsDir();
    const byId = new Map<string, Flow>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const flow = readJson<Flow | null>(join(dir, entry.name, FLOW_FILE), null);
        // A directory copied in the file manager carries the id it was copied from.
        // Only one of the two can answer to that id, and it is the one `flowFolder`
        // resolves to, so the list holds it rather than both.
        if (flow && !byId.has(flow.id)) byId.set(flow.id, flow);
    }
    return [...byId.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

export function getFlow(id: string): Flow | null {
    return readJson<Flow | null>(flowFile(id), null);
}

export function saveFlow(flow: Flow): Flow {
    const next: Flow = { ...flow, updatedAt: new Date().toISOString() };
    writeJson(flowFile(next.id), next);
    return next;
}

/**
 * Change what a flow is called, taking the graph as the file has it. Its own
 * call rather than a save of the whole flow, because a rename is something the
 * other window has to be told about and an ordinary canvas edit is not.
 */
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

/**
 * Write a flow that has no directory yet into one named after it. Every way a
 * flow is born — new, copied, imported — comes through here, so a folder is
 * never missing and never collides with one already in the workspace.
 */
function createIn(flow: Flow, folderFrom: string): Flow {
    const dir = flowDirNamed(freeFolder(toFolderName(folderFrom)));
    const next: Flow = { ...flow, updatedAt: new Date().toISOString() };
    writeJson(join(dir, FLOW_FILE), next);
    forgetFlowFolders();
    return next;
}

/**
 * Give a flow's directory another name. The id inside it is untouched, so every
 * run already recorded, every watermark and every reference an agent holds go on
 * meaning what they meant — only the path moves.
 */
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
 * Copy a flow into one of its own, taking the graph handed over — what is on
 * screen, unwritten edits and all — rather than what the original's file holds.
 * Its library comes too: those skills exist only inside that flow's directory,
 * so a copy without them names skills it does not have. Global ticks need no
 * such care, since that shelf is shared by every flow anyway.
 *
 * Node ids travel unchanged. They only have to be unique within a flow, and the
 * edges name them — reminting would mean rewriting every edge to no end. The
 * watcher's marks stay behind: a copy is a new flow, and starts as one.
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
    // Nothing will read this flow's watermarks again: ids are minted fresh, so no
    // later flow inherits them, and left behind they only grow the file. There is
    // one per trigger, so the flow's share of the file is taken by prefix.
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
 * Read a flow file the user picked. It lands as a new flow rather than replacing
 * one, so importing twice gives two copies and an import can never overwrite the
 * flow being edited. Everything in the file is run past `parseFlow` first, and
 * the skills it carries fill the new flow's library — without them a Processor
 * would name skills this install has never seen.
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
        // A global skill is only written where the name is free: this install's
        // shared library belongs to every other flow too, and an import is no
        // reason to rewrite one of them.
        if (skill.scope === 'global' && getSkill('global', '', skill.name)) continue;
        saveSkill(skill.scope, flow.id, skill.name, skill.content);
    }
    return flow;
}

// ── Workspaces written by an earlier version ─────────────────────────────

/**
 * A Processor written before the split names its skills bare. Anything now on
 * the global shelf is re-pointed at it, so the graph goes on meaning what it
 * meant; a name the flow holds itself is left alone, because that one already
 * resolves.
 */
function adoptGlobalRefs(flow: Flow, globalNames: Set<string>, ownNames: Set<string>): Flow | null {
    let changed = false;
    const nodes = flow.nodes.map((node): FlowNode => {
        if (node.config.kind !== 'processor') return node;
        const skills = node.config.skills.map((ref) => {
            if (isGlobalRef(ref) || ownNames.has(ref) || !globalNames.has(ref)) return ref;
            changed = true;
            return skillRef('global', ref);
        });
        return { ...node, config: { ...node.config, skills } };
    });
    return changed ? { ...flow, nodes } : null;
}

/**
 * Flows used to be `flows/<id>.json` beside one `.claude/skills` the whole
 * install shared. Give each flow a directory of its own, and hand that shared
 * library to the global shelf — which is what it always was — rather than
 * copying it into every flow.
 */
export function migrateToFlowDirectories(): string[] {
    const dir = flowsDir();
    const moved: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -'.json'.length);
        let target: string;
        try {
            target = flowDir(id);
        } catch {
            // A file whose name is not a usable id was never a flow of ours.
            continue;
        }
        renameSync(join(dir, entry.name), join(target, FLOW_FILE));
        moved.push(id);
    }
    if (moved.length > 0) forgetFlowFolders();

    const shared = join(workspaceRoot(), '.claude', 'skills');
    if (!existsSync(shared)) return moved;

    const adopted = new Set(importSkillsFrom('global', '', shared));
    // Removed rather than left: the cwd of a run is a flow's own directory now, so
    // a library above it is read by nothing and only invites edits that go nowhere.
    rmSync(join(workspaceRoot(), '.claude'), { recursive: true, force: true });

    for (const id of moved) {
        const flow = getFlow(id);
        if (!flow) continue;
        const next = adoptGlobalRefs(flow, adopted, new Set(listSkills('flow', id).map((s) => s.name)));
        if (next) saveFlow(next);
    }

    return moved;
}

/**
 * Those directories were named by the flow's id, and an id is a UUID — so the
 * project location the welcome window shows was thirty-six characters of
 * nothing. Name each one after its flow instead, once. A directory already
 * called something else is left alone: only the app's own naming is being undone.
 */
export function adoptFolderNames(): string[] {
    const renamed: string[] = [];
    for (const flow of listFlows()) {
        const folder = flowFolder(flow.id);
        if (folder !== flow.id) continue;
        const wanted = freeFolder(toFolderName(flow.name));
        try {
            renameSync(flowDirAt(folder), flowDirAt(wanted));
        } catch {
            // A directory the OS will not move stays where it is and still works.
            continue;
        }
        forgetFlowFolders();
        renamed.push(wanted);
    }
    return renamed;
}
