import { type JsonSchema, refName, schemaRef } from '@shared/flow';

/**
 * A JSON Schema as the schema editor and the Schemas tab see it: an object's
 * fields, each a name, a kind and a description, and whether it is required.
 * Every edit keeps what it does not touch, so a key the form has no control for
 * — a list's `minItems`, say — survives it.
 */

type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a field holds, as the form picks it. One of the workspace's named schemas is `ref:<name>`. */
export type Kind =
    | 'string'
    | 'choice'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'object'
    | 'array'
    | 'custom'
    | `ref:${string}`;

/** The kinds a field can be picked as, in the order offered; the workspace's named schemas follow them. */
export const KINDS: { kind: Kind; label: string }[] = [
    {kind: 'string', label: 'Text'},
    {kind: 'choice', label: 'One of a list'},
    {kind: 'number', label: 'Number'},
    {kind: 'integer', label: 'Whole number'},
    {kind: 'boolean', label: 'Yes / no'},
    {kind: 'object', label: 'Group of fields'},
    {kind: 'array', label: 'List'},
];

/** The same kinds, as what a list holds. */
const MANY: Record<string, string> = {
    string: 'text',
    choice: 'choices',
    number: 'numbers',
    integer: 'whole numbers',
    boolean: 'yes / no',
    object: 'groups',
    array: 'lists',
    custom: 'values',
};

/** Keys that make a schema more than the form can show: it is edited as JSON. */
const BEYOND_FORM = ['anyOf', 'oneOf', 'allOf', 'not', 'patternProperties'];

export function kindOf(field: unknown): Kind {
    if (!isObject(field)) return 'custom';
    const named = refName(field);
    if (named !== null) return `ref:${named}`;
    if (BEYOND_FORM.some((key) => key in field)) return 'custom';
    switch (field.type) {
        case 'string':
            if (!('enum' in field)) return 'string';
            return Array.isArray(field.enum) && field.enum.every((v) => typeof v === 'string') ? 'choice' : 'custom';
        case 'number':
        case 'integer':
        case 'boolean':
            return field.type;
        case 'object':
            // A map of any names to one kind of value, such as hbl_data, is not a group of fields.
            return isObject(field.additionalProperties) && !isObject(field.properties) ? 'custom' : 'object';
        case 'array':
            return 'array';
        default:
            return 'custom';
    }
}

export const fieldsOf = (schema: unknown): Json => (isObject(schema) && isObject(schema.properties) ? schema.properties : {});

export const requiredOf = (schema: unknown): string[] =>
    isObject(schema) && Array.isArray(schema.required)
        ? schema.required.filter((name): name is string => typeof name === 'string')
        : [];

/** A field's kind in a few words: “Text”, “List of numbers”, “Shipment”. */
export function kindLabel(field: unknown): string {
    const kind = kindOf(field);
    if (kind.startsWith('ref:')) return kind.slice('ref:'.length);
    const f = isObject(field) ? field : {};
    switch (kind) {
        case 'choice':
            return `One of: ${(f.enum as string[]).join(', ') || 'nothing yet'}`;
        case 'object': {
            const count = Object.keys(fieldsOf(f)).length;
            return count === 0 ? 'Any group' : `Group of ${count} field${count === 1 ? '' : 's'}`;
        }
        case 'array': {
            const items = kindOf(f.items);
            return `List of ${items.startsWith('ref:') ? items.slice('ref:'.length) : MANY[items]}`;
        }
        case 'custom':
            return isObject(f.additionalProperties) && !isObject(f.properties)
                ? `Names, each to ${kindLabel(f.additionalProperties).toLowerCase()}`
                : 'Other (JSON)';
        default:
            return KINDS.find((k) => k.kind === kind)?.label ?? kind;
    }
}

/**
 * Whether the form can show a whole schema: an object's fields, or nothing yet.
 * One that stands for a named schema, or is a list or a combination, is edited
 * as JSON.
 */
export function formable(schema: JsonSchema): boolean {
    if (refName(schema) !== null || BEYOND_FORM.some((key) => key in schema)) return false;
    return schema.type === undefined || (schema.type === 'object' && kindOf(schema) === 'object');
}

/** `schema` with `properties` and `required` put back, marked an object if it was not yet. */
function withFields(schema: JsonSchema, properties: Json, required: string[]): JsonSchema {
    return {...(schema.type === undefined ? {type: 'object'} : {}), ...schema, properties, required};
}

export function setField(schema: JsonSchema, name: string, field: unknown): JsonSchema {
    return withFields(schema, {...fieldsOf(schema), [name]: field}, requiredOf(schema));
}

/** Renamed where it stands, so the fields keep their order, and still required if it was. */
export function renameField(schema: JsonSchema, from: string, to: string): JsonSchema {
    const properties = Object.fromEntries(
        Object.entries(fieldsOf(schema)).map(([name, field]) => [name === from ? to : name, field]),
    );
    return withFields(schema, properties, requiredOf(schema).map((name) => (name === from ? to : name)));
}

export function removeField(schema: JsonSchema, name: string): JsonSchema {
    const {[name]: _, ...rest} = fieldsOf(schema);
    return withFields(schema, rest, requiredOf(schema).filter((n) => n !== name));
}

/** One place up (`by` −1) or down (+1). */
export function moveField(schema: JsonSchema, name: string, by: number): JsonSchema {
    const entries = Object.entries(fieldsOf(schema));
    const at = entries.findIndex(([n]) => n === name);
    const to = at + by;
    if (at < 0 || to < 0 || to >= entries.length) return schema;
    const [moved] = entries.splice(at, 1);
    entries.splice(to, 0, moved!);
    return withFields(schema, Object.fromEntries(entries), requiredOf(schema));
}

/** Required ones are listed in the fields' own order, so the file reads the way the form does. */
export function setRequired(schema: JsonSchema, name: string, on: boolean): JsonSchema {
    const wanted = new Set(requiredOf(schema));
    if (on) wanted.add(name);
    else wanted.delete(name);
    const names = Object.keys(fieldsOf(schema));
    const required = [...names.filter((n) => wanted.has(n)), ...[...wanted].filter((n) => !names.includes(n))];
    return withFields(schema, fieldsOf(schema), required);
}

/** A new text field at the end, required, under the first free name. */
export function addField(schema: JsonSchema): JsonSchema {
    const taken = fieldsOf(schema);
    let name = 'new_field';
    for (let n = 2; Object.hasOwn(taken, name); n++) name = `new_field_${n}`;
    return setRequired(setField(schema, name, {type: 'string'}), name, true);
}

/** The field as another kind. Its description stays; what only the old kind meant goes. */
export function retype(field: unknown, kind: Kind): Json {
    const f = isObject(field) ? field : {};
    const about = typeof f.description === 'string' ? {description: f.description} : {};
    if (kind.startsWith('ref:')) return {...schemaRef(kind.slice('ref:'.length)), ...about};
    switch (kind) {
        case 'choice':
            return {type: 'string', ...about, enum: Array.isArray(f.enum) ? f.enum : []};
        case 'object':
            return {type: 'object', ...about, properties: {}, required: []};
        case 'array':
            return {type: 'array', ...about, items: {type: 'string'}};
        case 'custom':
            return f;
        default:
            return {type: kind, ...about};
    }
}

/** The field with this description, or without one when it is blank. */
export function describeField(field: Json, text: string): Json {
    if (text !== '') return {...field, description: text};
    const {description: _, ...rest} = field;
    return rest;
}
