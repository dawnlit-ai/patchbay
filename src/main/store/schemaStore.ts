import { readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { schemasDir, schemasDirAt } from '../paths';
import { writeJson } from './jsonFile';
import { type JsonSchema, repointSchema, type Schemas, SLOT_NAME } from '@shared/flow';
import type { SchemaSummary } from '@shared/ipc';

/**
 * The open workspace's named schemas: `schemas/<name>.json`, each a JSON Schema
 * object, shared by every flow in the workspace. A node or a field refers to one
 * by its file's name, as {"$ref": "#/schemas/<name>"}, and no node keeps one of
 * its own. Renaming one also rewrites the flows that name it, and deleting one is
 * refused while they do, which is flowStore's half.
 */

/** A name a reference can spell, which is what makes the file a schema a node can pick. */
export const isValidSchemaName = (name: string): boolean => SLOT_NAME.test(name) && name.length <= 64;

const NAME_RULE = 'Use letters, digits and _ only, not starting with a digit.';

/** Where a schema of that name is, or would be. Creates nothing, so asking after one never makes the folder. */
const schemaFile = (name: string): string => join(schemasDirAt(), `${name}.json`);

function summarize(name: string, file: string): SchemaSummary {
    const base = {name, file, updatedAt: statSync(file).mtime.toISOString()};
    if (!isValidSchemaName(name)) {
        return {...base, schema: null, problem: `A node cannot refer to a file named “${name}”. ${NAME_RULE}`};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
        return {...base, schema: null, problem: `Not readable JSON: ${(e as Error).message}`};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {...base, schema: null, problem: 'Not a JSON object, so not a schema.'};
    }
    return {...base, schema: parsed as JsonSchema};
}

/**
 * Every `.json` file in the folder, by name, the ones a node cannot use
 * included, with why. One deleted mid-list is left out rather than failing it.
 */
export function listSchemas(): SchemaSummary[] {
    const dir = schemasDirAt();
    let entries;
    try {
        entries = readdirSync(dir, {withFileTypes: true});
    } catch {
        return [];
    }
    const out: SchemaSummary[] = [];
    for (const entry of entries) {
        if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith('.json')) continue;
        try {
            out.push(summarize(entry.name.slice(0, -'.json'.length), join(dir, entry.name)));
        } catch {
            // It went between the listing and the read.
        }
    }
    return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The ones a node can use, by name: what a run, and the canvas's checks, fill references in from. */
export function workspaceSchemas(): Schemas {
    return Object.fromEntries(listSchemas().flatMap((s) => (s.schema ? [[s.name, s.schema]] : [])));
}

/**
 * The one listed under `name`. The list it was picked from can be behind the
 * disk, so one gone since is refused by name. Only a name the folder lists is
 * ever turned into a path.
 */
export function findSchema(name: string): SchemaSummary {
    const found = listSchemas().find((s) => s.name === name);
    if (!found) {
        throw new Error(`“${name}” is no longer in this workspace’s schemas folder. It was deleted or renamed outside the app.`);
    }
    return found;
}

export const locateSchema = (name: string): string => findSchema(name).file;

/**
 * The schema the folder holds under `name` in another case, if any. Two of the
 * three filesystems we run on ignore case, so `shipment.json` would be written
 * into `Shipment.json` and a reference to `shipment` find nothing.
 */
const otherCase = (name: string, except?: string): string | undefined =>
    listSchemas().find((s) => s.name !== except && s.name.toLowerCase() === name.toLowerCase())?.name;

function checkName(name: string, except?: string): void {
    if (!isValidSchemaName(name)) throw new Error(`“${name}” cannot name a schema. ${NAME_RULE}`);
    const clash = otherCase(name, except);
    if (clash) throw new Error(`This workspace already has a schema called “${clash}”.`);
}

/** Write over the one of that name, or write it new. */
export function saveSchema(name: string, schema: JsonSchema): SchemaSummary {
    checkName(name, name);
    schemasDir();
    writeJson(schemaFile(name), schema);
    return summarize(name, schemaFile(name));
}

/** Write a new one. Refused when the folder already has that name, in any case. */
export function createSchema(name: string, schema: JsonSchema): SchemaSummary {
    checkName(name);
    return saveSchema(name, schema);
}

/** Every other schema in the folder that `edit` changes, written with the change. */
function editOthers(except: string, edit: (schema: JsonSchema) => JsonSchema): void {
    for (const other of listSchemas()) {
        if (other.name === except || !other.schema) continue;
        const next = edit(other.schema);
        if (JSON.stringify(next) !== JSON.stringify(other.schema)) writeJson(other.file, next);
    }
}

/** Rename the file, and repoint each other schema that refers to it. */
export function renameSchemaFile(from: string, to: string): void {
    const {file} = findSchema(from);
    if (to === from) return;
    checkName(to, from);
    renameSync(file, schemaFile(to));
    editOthers(to, (schema) => repointSchema(schema, from, to));
}

/** Delete the file. Whether anything still uses it is the caller's to have asked. */
export function removeSchemaFile(name: string): void {
    rmSync(findSchema(name).file, {force: true});
}

/**
 * Put a schema a node kept to itself into the folder, and say what it is called
 * there: the first of `wanted` that already holds it to the letter, else the
 * first that is free, else the first numbered past the first of them.
 */
export function adoptNodeSchema(schema: JsonSchema, wanted: string[]): string {
    const names = wanted.filter(isValidSchemaName);
    if (names.length === 0) names.push('Schema');
    const there = new Map(listSchemas().map((s) => [s.name.toLowerCase(), s]));
    const same = names.find((name) => {
        const held = there.get(name.toLowerCase());
        return held?.name === name && JSON.stringify(held.schema) === JSON.stringify(schema);
    });
    if (same) return same;
    let name = names.find((n) => !there.has(n.toLowerCase()));
    if (!name) {
        const base = names[0]!;
        name = base;
        for (let n = 2; there.has(name.toLowerCase()); n++) name = `${base}${n}`;
    }
    saveSchema(name, schema);
    return name;
}

/**
 * Put schemas a flow file carried into the folder. One the folder already has,
 * the same to the letter, is left as it is; one whose name the folder gives
 * another schema is written under a free name. Returns the names that changed,
 * old → new, for the flow's references to follow.
 */
export function adoptSchemas(carried: Schemas): Map<string, string> {
    const renamed = new Map<string, string>();
    const names = Object.keys(carried);
    if (names.length === 0) return renamed;
    const there = new Map(listSchemas().map((s) => [s.name.toLowerCase(), s]));
    // A free name must not be one the flow carries either, or two would land on it.
    const taken = new Set([...there.keys(), ...names.map((n) => n.toLowerCase())]);
    const same = new Set<string>();
    for (const name of names) {
        const held = there.get(name.toLowerCase());
        if (!held) continue;
        if (held.name === name && JSON.stringify(held.schema) === JSON.stringify(carried[name])) {
            same.add(name);
            continue;
        }
        let free = name;
        for (let n = 2; taken.has(free.toLowerCase()); n++) free = `${name}${n}`;
        taken.add(free.toLowerCase());
        renamed.set(name, free);
    }
    for (const name of names) {
        if (same.has(name)) continue;
        let schema = carried[name]!;
        for (const [from, to] of renamed) schema = repointSchema(schema, from, to);
        schemasDir();
        writeJson(schemaFile(renamed.get(name) ?? name), schema);
    }
    return renamed;
}
