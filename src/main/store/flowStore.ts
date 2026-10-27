import { readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    flowFile,
    flowFileNamed,
    flowHomes,
    flowsDir,
    flowsDirAt,
    forgetFlowHomes,
    isSafeSegment,
    samePath,
    watermarkFile,
} from '../paths';
import { readJson, writeJson } from './jsonFile';
import { getSkill, isValidSkillName, saveSkill } from './skillStore';
import {
    adoptNodeSchema,
    adoptSchemas,
    findSchema,
    removeSchemaFile,
    renameSchemaFile,
    workspaceSchemas,
} from './schemaStore';
import {
    editSchemas,
    emptyFlow,
    type Flow,
    type JsonSchema,
    parseFlow,
    parseSchemas,
    refName,
    repointSchema,
    schemaHolders,
    schemaRef,
} from '@shared/flow';
import { toFolderName } from '@shared/naming';
import type { FlowEntry, SaveOutcome } from '@shared/ipc';

/**
 * A flow is a file in the open workspace's `flows` folder, named after it, and
 * the user can rename it. The id inside the file cannot change, since runs and
 * watermarks are keyed by it.
 */

/**
 * A flow file, repaired the way an import is, so a node saved before a config
 * field existed arrives with that field's default rather than without it.
 */
function readFlowFile(path: string): Flow | null {
    const raw = readJson<Record<string, unknown> | null>(path, null);
    if (!raw || typeof raw.id !== 'string') return null;
    const flow = parseFlow(raw, raw.id, typeof raw.name === 'string' ? raw.name : 'Untitled flow');
    // Kept as written: it is the version a canvas saves against.
    return typeof raw.updatedAt === 'string' ? {...flow, updatedAt: raw.updatedAt} : flow;
}

/** Write a flow over its file, keeping whatever else the file holds: one written by hand may carry more than the graph. */
function writeFlowFile(path: string, flow: Flow): void {
    const raw = readJson<unknown>(path, null);
    const rest = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
    writeJson(path, {...rest, ...flow});
}

export function listFlows(): Flow[] {
    return [...flowHomes().values()]
        .flatMap((file) => readFlowFile(file) ?? [])
        .toSorted((a, b) => a.name.localeCompare(b.name));
}

export function getFlow(id: string): Flow | null {
    const flow = readFlowFile(flowFile(id));
    // A file written over since by another flow is that flow's now.
    return flow?.id === id ? flow : null;
}

export function saveFlow(flow: Flow): Flow {
    // Strictly later than what it replaces. updatedAt is the version a canvas saves
    // against, so two writes landing in one millisecond must not share one.
    const previous = Date.parse(getFlow(flow.id)?.updatedAt ?? '');
    const stamp = Number.isNaN(previous) ? Date.now() : Math.max(Date.now(), previous + 1);
    const next: Flow = {...flow, updatedAt: new Date(stamp).toISOString()};
    flowsDir();
    writeFlowFile(flowFile(next.id), next);
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
    if (!current || current.updatedAt !== (mine.get(key) ?? flow.updatedAt)) return {current};
    const saved = saveFlow(flow);
    mine.set(key, saved.updatedAt);
    return {saved};
}

/** A window closed: nothing it sent will be resolved again. */
export function forgetWriter(writer: string): void {
    lineage.delete(writer);
}

/** Rename a flow. Separate from a save, because other windows are told about a rename. */
export function renameFlow(id: string, name: string): Flow {
    const flow = getFlow(id);
    if (!flow) throw new Error('That flow is no longer in the workspace.');
    return saveFlow({...flow, name});
}

// ── Where a flow lives ───────────────────────────────────────────────────

export function entryFor(flow: Flow): FlowEntry {
    return {flow, file: flowFile(flow.id)};
}

export function listFlowEntries(): FlowEntry[] {
    return listFlows().map(entryFor);
}

/** File names in use in `flows`, without `.json` and lowercased: two of the three filesystems we run on ignore case. */
function takenNames(): Set<string> {
    let names: string[];
    try {
        names = readdirSync(flowsDirAt());
    } catch {
        names = [];
    }
    return new Set(names.filter((n) => n.toLowerCase().endsWith('.json')).map((n) => n.slice(0, -5).toLowerCase()));
}

/** That name, or the first numbered variant of it no other flow file has. */
function freeName(wanted: string, except?: string): string {
    const taken = takenNames();
    if (except) taken.delete(except.toLowerCase());
    let name = wanted;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted}-${n}`;
    return name;
}

/** Write a new flow into a file of its own, named after it. Every new, copied and imported flow comes through here. */
function createIn(flow: Flow): Flow {
    const next: Flow = {...flow, updatedAt: new Date().toISOString()};
    flowsDir();
    writeJson(flowFileNamed(freeName(toFolderName(flow.name))), next);
    forgetFlowHomes();
    return next;
}

/** Rename a flow's file. Its id, and everything keyed by it, is untouched. */
export function setFlowFileName(flowId: string, requested: string): FlowEntry {
    const flow = getFlow(flowId);
    if (!flow) throw new Error('That flow is no longer in the workspace.');
    const file = flowFile(flowId);
    const current = basename(file).replace(/\.json$/i, '');
    const wanted = toFolderName(requested);
    if (wanted !== current) {
        if (freeName(wanted, current) !== wanted) {
            throw new Error(`Another flow's file is already called “${wanted}.json”.`);
        }
        renameSync(file, flowFileNamed(wanted));
        forgetFlowHomes();
    }
    return entryFor(flow);
}

// ── Making and unmaking ──────────────────────────────────────────────────

/** A new, empty flow in the open workspace. */
export function createFlow(name: string): Flow {
    return createIn(emptyFlow(randomUUID(), name));
}

/**
 * Copy the graph handed over (what is on screen, unsaved edits included) into a
 * new flow. Node ids are kept, as they only need to be unique within a flow;
 * watermarks are not. The skills it ticks are the workspace's, so both share them.
 */
export function duplicateFlow(source: Flow, name: string): Flow {
    return createIn({...source, id: randomUUID(), name});
}

/** Deletes a flow's file, and its watermarks. The skills it ticked are the workspace's, and stay. */
export function removeFlow(id: string): void {
    rmSync(flowFile(id), {force: true});
    forgetFlowHomes();
    // One per trigger, keyed `<flowId>:<nodeId>`.
    const marks = readJson<Record<string, unknown>>(watermarkFile(), {});
    const mine = Object.keys(marks).filter((key) => key.startsWith(`${id}:`));
    if (mine.length > 0) {
        for (const key of mine) delete marks[key];
        writeJson(watermarkFile(), marks);
    }
}

// ── Named schemas ────────────────────────────────────────────────────────
// Every schema is the workspace's, a file each in its `schemas` folder, and a
// node only ever names one. So renaming one rewrites the flows that name it, and
// deleting one is refused while anything does.

/** Each flow whose nodes `edit` changes, saved with the change. */
function editFlowSchemas(edit: (schema: JsonSchema) => JsonSchema): void {
    for (const flow of listFlows()) {
        const next = editSchemas(flow, edit);
        if (JSON.stringify(next.nodes) !== JSON.stringify(flow.nodes)) saveFlow(next);
    }
}

/** Rename a schema, and every reference to it, in the workspace's flows and its other schemas. */
export function renameSchema(from: string, to: string): void {
    // First, since it is the half that refuses: a name taken, or the schema gone.
    renameSchemaFile(from, to);
    if (to !== from) editFlowSchemas((schema) => repointSchema(schema, from, to));
}

/** Phrases as a sentence joins them: A, A and B, A, B and C. */
const together = (phrases: string[]): string =>
    phrases.length < 2 ? (phrases[0] ?? '') : `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;

/**
 * Delete a schema. Refused while a node in any flow, or another schema, still
 * names it: no node keeps a schema of its own, so there is nowhere a copy could go.
 */
export function removeSchema(name: string): void {
    findSchema(name);
    const holders = schemaHolders(listFlows(), workspaceSchemas(), name);
    if (holders.length > 0) {
        throw new Error(`${name} is in use by ${together(holders)}. Have those use another schema first, then delete it.`);
    }
    removeSchemaFile(name);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** `rate replies`, `pre_alert` → RateReplies, PreAlert: the words run together, as a schema is named. */
const pascal = (text: string): string =>
    text
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((word) => word[0]!.toUpperCase() + word.slice(1))
        .join('');

/** A schema a node in a flow file keeps to itself, and the slot it fills with it; null when it only names one. */
function ownSchema(node: unknown): { schema: JsonSchema; output: string; used: boolean } | null {
    if (!isObject(node) || (node.kind !== 'extractor' && node.kind !== 'processor')) return null;
    const config = node.config;
    if (!isObject(config) || !isObject(config.schema)) return null;
    if (refName(config.schema) !== null || Object.keys(config.schema).length === 0) return null;
    const output = typeof config.output === 'string' ? config.output : '';
    // A Processor that fills no slot never uses its schema.
    return {schema: config.schema, output, used: node.kind === 'extractor' || output !== ''};
}

/**
 * Bring a flow file up to every schema being the workspace's, writing it only
 * when something moved. Schemas it keeps under `schemas`, from before they were
 * the workspace's, go into the folder, each under a free name when the folder
 * gives its own to another, and the file's references follow. So does a schema
 * a node keeps to itself: named after the slot it fills (`notice` → Notice), or
 * after the flow and the slot when that name is taken (RateRepliesAck), and the
 * node names it instead. One on a Processor that fills no slot is never used,
 * and is dropped.
 */
function adoptSchemasIn(file: string): void {
    const raw = readJson<unknown>(file, null);
    if (!isObject(raw)) return;
    let next: Record<string, unknown> = raw;
    let moved = false;
    if ('schemas' in next) {
        const {schemas, ...rest} = next;
        next = rest;
        for (const [from, to] of adoptSchemas(parseSchemas(schemas))) next = repointSchema(next, from, to);
        moved = true;
    }
    if (Array.isArray(next.nodes)) {
        const flowName = typeof next.name === 'string' ? next.name : '';
        const nodes = next.nodes.map((node: unknown) => {
            const own = ownSchema(node);
            if (!own) return node;
            moved = true;
            const holder = node as { config: Record<string, unknown> };
            if (!own.used) return {...holder, config: {...holder.config, schema: {}}};
            const slot = pascal(own.output);
            const name = adoptNodeSchema(own.schema, [slot, `${pascal(flowName)}${slot}`]);
            return {...holder, config: {...holder.config, schema: schemaRef(name)}};
        });
        next = {...next, nodes};
    }
    if (moved) writeJson(file, next);
}

/** Bring every flow file in the workspace up to every schema being the workspace's. Done as a workspace opens. */
export function adoptFlowSchemas(): void {
    for (const file of flowHomes().values()) adoptSchemasIn(file);
}

// ── Flow files from elsewhere ────────────────────────────────────────────

/** What a flow file may carry beside the graph, so it can be run elsewhere. */
interface BundledSkill {
    name: string;
    content: string;
}

function bundledSkills(raw: unknown): BundledSkill[] {
    const list = (raw as { skills?: unknown }).skills;
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry): BundledSkill[] => {
        const {name, content} = (entry ?? {}) as { name?: unknown; content?: unknown };
        if (typeof name !== 'string' || typeof content !== 'string') return [];
        if (!isValidSkillName(name)) return [];
        return [{name, content}];
    });
}

/**
 * Copy a flow file into the workspace, as a file of its own named after the
 * flow. One already in the workspace's `flows` is just read. The id inside is
 * kept unless a flow here already has it — then this is a copy, and gets one of
 * its own. Skills it carries go into the library, never over one already there,
 * and schemas — whether the file keeps them beside its nodes or a node keeps
 * one to itself — into the schemas folder, as opening a workspace moves them.
 */
export function importFlowFile(path: string): Flow {
    const file = resolve(path);
    const label = basename(file);
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        throw new Error(`${label} is not readable JSON.`);
    }
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { nodes?: unknown }).nodes)) {
        throw new Error(`${label} does not look like a Patchbay flow.`);
    }
    const fields = raw as Record<string, unknown>;
    // Ids name files and key watermarks, so one written by hand has to be fit for both.
    const ownId = typeof fields.id === 'string' && isSafeSegment(fields.id) ? fields.id : null;
    const held = ownId === null ? undefined : flowHomes().get(ownId);
    if (ownId !== null && held && samePath(held, file)) {
        const flow = getFlow(ownId);
        if (flow) return flow;
    }
    const id = ownId !== null && !held ? ownId : randomUUID();
    const name = typeof fields.name === 'string' ? fields.name : label.replace(/\.json$/i, '') || 'Imported flow';
    let flow: Flow | null;
    if (samePath(dirname(file), flowsDirAt())) {
        // In the folder already but not listed: written without an id, or a copy of
        // another flow's file. It stays where it is, with an id of its own.
        const updatedAt = typeof fields.updatedAt === 'string' ? fields.updatedAt : new Date().toISOString();
        writeJson(file, {...fields, id, name, updatedAt});
        adoptSchemasIn(file);
        forgetFlowHomes();
        flow = getFlow(id);
        if (!flow) throw new Error(`${label} could not be read back after opening it.`);
    } else {
        // Repaired on the way in, and without the skills and schemas it carried: those
        // go into the workspace's folders, and its references follow any renamed there.
        const {skills: _, schemas, ...rest} = fields;
        let graph: Record<string, unknown> = {...rest, id, name};
        for (const [from, to] of adoptSchemas(parseSchemas(schemas))) graph = repointSchema(graph, from, to);
        const created = createIn(parseFlow(graph, id, name));
        adoptSchemasIn(flowFile(created.id));
        flow = getFlow(created.id) ?? created;
    }
    for (const skill of bundledSkills(raw)) {
        // Never over a skill already there: other flows in the workspace use it.
        if (getSkill(skill.name)) continue;
        saveSkill(skill.name, skill.content);
    }
    return flow;
}
