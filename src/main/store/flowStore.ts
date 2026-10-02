import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    FLOW_FILE,
    flowDir,
    flowDirAt,
    flowDirNamed,
    flowFile,
    flowHome,
    type FlowHome,
    flowHomes,
    flowsDir,
    flowSkillsDir,
    flowSkillsDirAt,
    forgetFlowHomes,
    isSafeSegment,
    openedFlowFiles,
    samePath,
    setOpenedFlowFiles,
    watermarkFile,
} from '../paths';
import { readJson, writeJson } from './jsonFile';
import { getSkill, isValidSkillName, saveSkill } from './skillStore';
import { emptyFlow, type Flow, parseFlow } from '@shared/flow';
import { toFolderName } from '@shared/naming';
import type { FlowEntry, SaveOutcome } from '@shared/ipc';
import type { SkillScope } from '@shared/settings';

/**
 * A flow is a file in a directory, beside the flow's own `.claude/skills`, and
 * that directory is the cwd its Processors run in. One made here lives at
 * `flows/<folder>/flow.json`, and its folder can be renamed; one opened from
 * elsewhere stays where it is. Either way the id inside the file cannot change,
 * since runs and watermarks are keyed by it.
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
    return typeof raw.updatedAt === 'string' ? { ...flow, updatedAt: raw.updatedAt } : flow;
}

/** Write a flow over its file, keeping whatever else the file holds: one opened in place may carry more than the graph. */
function writeFlowFile(path: string, flow: Flow): void {
    const raw = readJson<unknown>(path, null);
    const rest = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
    writeJson(path, { ...rest, ...flow });
}

export function listFlows(): Flow[] {
    return [...flowHomes().values()]
        .flatMap(({ file }) => readFlowFile(file) ?? [])
        .toSorted((a, b) => a.name.localeCompare(b.name));
}

export function getFlow(id: string): Flow | null {
    // Not through flowFile, which makes the directory it names: asking after a
    // flow that was deleted, or never was, should not leave a folder behind.
    const flow = readFlowFile(flowHome(id).file);
    // A file written over since by another flow is that flow's now.
    return flow?.id === id ? flow : null;
}

export function saveFlow(flow: Flow): Flow {
    // Strictly later than what it replaces. updatedAt is the version a canvas saves
    // against, so two writes landing in one millisecond must not share one.
    const previous = Date.parse(getFlow(flow.id)?.updatedAt ?? '');
    const stamp = Number.isNaN(previous) ? Date.now() : Math.max(Date.now(), previous + 1);
    const next: Flow = { ...flow, updatedAt: new Date(stamp).toISOString() };
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

export function entryFor(flow: Flow): FlowEntry {
    const { file, inPlace } = flowHome(flow.id);
    const path = dirname(file);
    return { flow, folder: basename(path), path, file, inPlace };
}

export function listFlowEntries(): FlowEntry[] {
    return listFlows().map(entryFor);
}

/** Where a flow lives, a workspace flow's folder made if missing so there is something to show. */
export function flowLocation(flowId: string): FlowHome {
    flowDir(flowId);
    return flowHome(flowId);
}

/** Names in use in a folder, lowercased: two of the three filesystems we run on ignore case. */
function takenNames(parent: string): Set<string> {
    return new Set(readdirSync(parent).map((name) => name.toLowerCase()));
}

/** That name, or the first numbered variant of it nothing in the folder already has. */
function freeFolder(wanted: string, except?: string, parent = flowsDir()): string {
    const taken = takenNames(parent);
    if (except) taken.delete(except.toLowerCase());
    let name = wanted;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted}-${n}`;
    return name;
}

/**
 * Write a new flow into a fresh folder named after it. Given a location, the
 * folder goes there and the flow is kept in place like an opened file; without
 * one, it goes in the workspace. Every new and copied flow comes through here.
 */
function createIn(flow: Flow, location?: string): Flow {
    const next: Flow = { ...flow, updatedAt: new Date().toISOString() };
    const folder = toFolderName(flow.name);
    if (location === undefined) {
        writeJson(join(flowDirNamed(freeFolder(folder)), FLOW_FILE), next);
        forgetFlowHomes();
        return next;
    }
    if (!isAbsolute(location)) throw new Error(`"${location}" is not a full path. Choose a folder for the flow.`);
    const parent = resolve(location);
    mkdirSync(parent, { recursive: true });
    // Numbered past anything already there, so a new flow never moves into someone's folder.
    const dir = join(parent, freeFolder(folder, undefined, parent));
    mkdirSync(dir);
    const file = join(dir, FLOW_FILE);
    writeJson(file, next);
    setOpenedFlowFiles([file, ...openedFlowFiles()]);
    return next;
}

/** Rename a flow's directory. Its id, and everything keyed by it, is untouched. */
export function setFlowFolder(flowId: string, requested: string): FlowEntry {
    const flow = getFlow(flowId);
    if (!flow) throw new Error('That flow is no longer in the workspace.');
    const home = flowHome(flowId);
    if (home.inPlace) {
        throw new Error(`This flow was opened from ${home.file}. Its folder is yours to rename, outside the app.`);
    }
    const current = basename(dirname(home.file));
    const wanted = toFolderName(requested);
    if (wanted !== current) {
        if (freeFolder(wanted, current) !== wanted) {
            throw new Error(`Another flow's folder is already called “${wanted}”.`);
        }
        renameSync(dirname(home.file), flowDirAt(wanted));
        forgetFlowHomes();
    }
    return entryFor(flow);
}

// ── Making and unmaking ──────────────────────────────────────────────────

/** A new, empty flow, in `location` or else the workspace (see `createIn`). */
export function createFlow(name: string, location?: string): Flow {
    // Its own library starts empty; the global one is already shared.
    return createIn(emptyFlow(randomUUID(), name), location);
}

/**
 * Copy the graph handed over (what is on screen, unsaved edits included) into a
 * new flow, in `location` or else the workspace, along with its own skill library.
 * Node ids are kept, as they only need to be unique within a flow; watermarks are not.
 */
export function duplicateFlow(source: Flow, name: string, location?: string): Flow {
    const copy = createIn({ ...source, id: randomUUID(), name }, location);
    // Read where it is: making it would leave an empty library in a folder opened in place.
    const library = flowSkillsDirAt(source.id);
    if (existsSync(library)) cpSync(library, flowSkillsDir(copy.id), { recursive: true });
    return copy;
}

/**
 * Deletes a workspace flow's directory, its skills included. One opened in place
 * is only taken off the list: its file and folder are the user's. Either way its
 * watermarks go.
 */
export function removeFlow(id: string): void {
    const home = flowHome(id);
    if (home.inPlace) {
        setOpenedFlowFiles(openedFlowFiles().filter((file) => !samePath(file, home.file)));
    } else {
        rmSync(dirname(home.file), { recursive: true, force: true });
        forgetFlowHomes();
    }
    // One per trigger, keyed `<flowId>:<nodeId>`.
    const marks = readJson<Record<string, unknown>>(watermarkFile(), {});
    const mine = Object.keys(marks).filter((key) => key.startsWith(`${id}:`));
    if (mine.length > 0) {
        for (const key of mine) delete marks[key];
        writeJson(watermarkFile(), marks);
    }
}

// ── Flow files opened from elsewhere ─────────────────────────────────────

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
 * Open a flow file where it is, rather than copying it in: it is listed, saved
 * back to, and its folder is where its runs work and its own skills live.
 *
 * The id inside is kept unless another flow's file still holds it — then this is a
 * copy, and gets one of its own. A file the id was listed at and that has since
 * gone means this one was moved there, so its runs and watermarks follow it.
 */
export function openFlowFile(path: string): Flow {
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
    const readBack = (id: string): Flow => {
        const flow = getFlow(id);
        if (!flow) throw new Error(`${label} could not be read back after opening it.`);
        return flow;
    };
    // Ids name folders and key watermarks, so one written by hand has to be fit for both.
    const ownId = typeof fields.id === 'string' && isSafeSegment(fields.id) ? fields.id : null;
    const held = ownId === null ? undefined : flowHomes().get(ownId);
    // Listed already: opened before, or a workspace flow's own file.
    if (ownId !== null && held && samePath(held.file, file)) return readBack(ownId);

    // Without its own id, or a version for a canvas to save against, a file would
    // read as a different flow, or a newer one, every time.
    const stamp = {
        id: ownId !== null && !held ? ownId : randomUUID(),
        name: typeof fields.name === 'string' ? fields.name : label.replace(/\.json$/i, '') || 'Opened flow',
        updatedAt: typeof fields.updatedAt === 'string' ? fields.updatedAt : new Date().toISOString(),
    };
    const { id } = stamp;
    if (id !== fields.id || stamp.name !== fields.name || stamp.updatedAt !== fields.updatedAt) {
        writeJson(file, { ...fields, ...stamp });
    }
    setOpenedFlowFiles([file, ...openedFlowFiles().filter((listed) => !samePath(listed, file))]);

    const flow = readBack(id);
    for (const skill of bundledSkills(raw)) {
        // Never over a skill already there: one beside the file is the user's, and
        // a global one other flows use.
        if (getSkill(skill.scope, flow.id, skill.name)) continue;
        saveSkill(skill.scope, flow.id, skill.name, skill.content);
    }
    return flow;
}
