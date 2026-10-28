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
const isValidSchemaName = (name: string): boolean => SLOT_NAME.test(name) && name.length <= 64;

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

/** Rename the file, and repoint each other schema that refers to it. */
export function renameSchemaFile(from: string, to: string): void {
    const {file} = findSchema(from);
    if (to === from) return;
    checkName(to, from);
    renameSync(file, schemaFile(to));
    for (const other of listSchemas()) {
        if (other.name === to || !other.schema) continue;
        const next = repointSchema(other.schema, from, to);
        if (JSON.stringify(next) !== JSON.stringify(other.schema)) writeJson(other.file, next);
    }
}

/** Delete the file. Whether anything still uses it is the caller's to have asked. */
export function removeSchemaFile(name: string): void {
    rmSync(findSchema(name).file, {force: true});
}
