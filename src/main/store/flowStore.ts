import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { flowDir, flowsDir, flowSkillsDir, watermarkFile, workspaceRoot } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { getSkill, importSkillsFrom, isValidSkillName, listSkills, saveSkill } from './skillStore';
import { emptyFlow, type Flow, type FlowNode, parseFlow } from '@shared/flow';
import { isGlobalRef, skillRef, type SkillScope } from '@shared/settings';

/**
 * A flow is a directory rather than a file: `flows/<id>/flow.json` sits beside
 * the `.claude/skills` tree only this flow's Processors can reach, and that
 * directory is the cwd they run in. The global library is elsewhere and shared,
 * so nothing here touches it beyond what an export carries.
 */

const FLOW_FILE = 'flow.json';

const filePath = (id: string): string => join(flowDir(id), FLOW_FILE);

export function listFlows(): Flow[] {
    const dir = flowsDir();
    const flows = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readJson<Flow | null>(join(dir, entry.name, FLOW_FILE), null))
        .filter((f): f is Flow => f !== null);

    // A fresh install starts with one empty flow, rather than an empty list and
    // nothing to drag a node onto.
    if (flows.length === 0) return [createFlow('My first flow')];
    return flows.toSorted((a, b) => a.name.localeCompare(b.name));
}

export function getFlow(id: string): Flow | null {
    return readJson<Flow | null>(filePath(id), null);
}

export function saveFlow(flow: Flow): Flow {
    const next: Flow = { ...flow, updatedAt: new Date().toISOString() };
    writeJson(filePath(next.id), next);
    return next;
}

export function createFlow(name: string): Flow {
    // Its own library starts empty: the global one is already on the shelf, and a
    // flow-specific skill is something you decide to write, not inherit.
    return saveFlow(emptyFlow(randomUUID(), name));
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
    const copy = saveFlow({ ...source, id: randomUUID(), name });
    cpSync(flowSkillsDir(source.id), flowSkillsDir(copy.id), { recursive: true });
    return copy;
}

/** Takes the flow's directory — its own skills and all — and the watcher's mark. */
export function removeFlow(id: string): void {
    rmSync(flowDir(id), { recursive: true, force: true });
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

/** What a flow file carries beside the graph, so an export can be run elsewhere. */
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
    const flow = saveFlow(parseFlow(raw, randomUUID(), label.replace(/\.json$/i, '') || 'Imported flow'));

    for (const skill of bundledSkills(raw)) {
        // A global skill is only written where the name is free: this install's
        // shared library belongs to every other flow too, and an import is no
        // reason to rewrite one of them.
        if (skill.scope === 'global' && getSkill('global', '', skill.name)) continue;
        saveSkill(skill.scope, flow.id, skill.name, skill.content);
    }
    return flow;
}

/**
 * Write a flow out in the app's own format, so the copy imports cleanly. Every
 * skill it names goes in the same file — its own, and the global ones it ticks —
 * because a graph naming skills the other end lacks is a flow that cannot run.
 * Only each `SKILL.md` travels; anything else in a skill folder stays behind.
 */
export function exportFlowFile(flow: Flow, path: string): void {
    const ticked = new Set(
        flow.nodes.flatMap((node) => (node.config.kind === 'processor' ? node.config.skills : [])),
    );
    const wanted = [
        // The whole of this flow's own library, since it exists only for this flow,
        // and just the global skills the graph actually reaches for.
        ...listSkills('flow', flow.id),
        ...listSkills('global', flow.id).filter((s) => ticked.has(skillRef('global', s.name))),
    ];
    const skills = wanted.flatMap((summary): BundledSkill[] => {
        const detail = getSkill(summary.scope, flow.id, summary.name);
        return detail ? [{ name: summary.name, scope: summary.scope, content: detail.content }] : [];
    });
    writeJson(path, { ...flow, skills });
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
