/**
 * The flow graph — drawn by the canvas, walked by the engine, written to disk.
 * Imported by both renderer and main, so it stays free of Node and DOM.
 */

export type NodeKind = 'trigger.outlook' | 'categorizer' | 'extractor' | 'processor' | 'terminal';

export type Disposition = 'done' | 'needs-review' | 'ignored' | 'failed';

// As values too, for the inspector to offer and the importer to check against.
export const NODE_KINDS: NodeKind[] = ['trigger.outlook', 'categorizer', 'extractor', 'processor', 'terminal'];
export const DISPOSITIONS: Disposition[] = ['done', 'needs-review', 'ignored', 'failed'];

/** One branch of a categorizer — the description is what the model matches on. */
export interface Category {
    id: string;
    label: string;
    description: string;
}

export interface TriggerConfig {
    /** SMTP address as Outlook reports it. Empty until the user picks one. */
    account: string;
    /**
     * The folders read, each by its path under the Inbox ("Clients\Acme"),
     * with '' for the Inbox itself. Each is read on its own, not the folders in
     * it, and a folder made later is read only once it is ticked.
     */
    folders: string[];
    pollSeconds: number;
    /** How far back each poll looks. Keeps the COM walk cheap. */
    lookbackDays: number;
    maxPerPoll: number;
    /**
     * Whether mail already in the folder counts as new on the first poll. Off by
     * default: switching a flow on should not replay last week's mail.
     */
    processBacklogOnStart: boolean;
}

/** Where a trigger reads its mail: the folders it ticks. */
export type MailScope = Pick<TriggerConfig, 'account' | 'folders'>;

type FolderChoice = Pick<TriggerConfig, 'folders'>;

/** Whether a trigger reads a folder, given by its path under the Inbox. Outlook's folder names ignore case. */
export const readsFolder = (choice: FolderChoice, path: string): boolean =>
    choice.folders.some((f) => f.toLowerCase() === path.toLowerCase());

/** The one folder a trigger reads, when it reads just one; null otherwise. */
export const soleFolder = (choice: FolderChoice): string | null =>
    choice.folders.length === 1 ? (choice.folders[0] ?? null) : null;

/** The folders a trigger reads, in a few words: `Inbox`, `Invoices` or `3 folders`. */
export function folderLabel(choice: FolderChoice): string {
    const {folders} = choice;
    if (folders.length === 0) return 'no folder';
    return folders.length === 1 ? folders[0] || 'Inbox' : `${folders.length} folders`;
}

/**
 * A model and its level, as a node lists one. A step runs on the first one that
 * is on, and goes to the next one on in turn when the one before is at its usage
 * limit, or its agent cannot be reached, and nothing that changes things has run yet.
 */
export interface ModelChoice {
    model: string;
    /** One of the levels the model takes, as Claude Code or agy lists them. Empty uses the model's default. */
    effort: string;
    /** Off, the step passes it over, and it keeps its place for when it is turned back on. */
    enabled: boolean;
}

/** The models a step tries, in the order it tries them. A node always has at least one. */
export const modelsInTurn = (models: ModelChoice[]): ModelChoice[] => models.filter((m) => m.enabled);

export interface CategorizerConfig {
    categories: Category[];
    /** The models the step runs on: the first one on, then each one on after it while the one before cannot take it. */
    models: ModelChoice[];
    /** Fetch the full body before classifying. Off = subject and preview only. */
    includeBody: boolean;
    bodyMaxChars: number;
}

export interface ExtractorConfig {
    /** The slot later nodes read the result by, e.g. "order". */
    output: string;
    /**
     * The workspace schema the result has to match to leave by Valid, named as
     * {"$ref": "#/schemas/<name>"}: a node never keeps one of its own. Empty until
     * one is picked.
     */
    schema: JsonSchema;
    /** What to extract and from where, beyond what the schema's descriptions say. */
    instruction: string;
    /** Skills ticked as a Processor ticks them: how to read this kind of email. */
    skills: string[];
    /** Slots an earlier node filled, put into the prompt as JSON after the email. */
    inputs: string[];
    /** The models the step runs on: the first one on, then each one on after it while the one before cannot take it. */
    models: ModelChoice[];
    /** Let it save the attachments and read them, not just the body. */
    includeAttachments: boolean;
    /** Tools from the workspace's MCP servers, spelled as a Processor's are. Meant for lookups only. */
    mcpTools: string[];
}

export interface ProcessorConfig {
    /** Ticked skills, by name, from the workspace's library. */
    skills: string[];
    /** Free-text instruction prepended to the email context. */
    instruction: string;
    /**
     * Whether Claude gets the email's content: its body in the prompt, `read_email`,
     * and its attachments. Off, the node works from `inputs` alone; drafting a reply
     * and moving the email still act on it.
     */
    readEmail: boolean;
    /** Slots an earlier node filled, put into the prompt as JSON. */
    inputs: string[];
    /**
     * The slot later nodes read this node's result by, filled when it leaves by
     * Done. Empty fills nothing: the node reports how it went and hands on no data.
     */
    output: string;
    /**
     * The workspace schema that result has to match, named as an Extractor's is.
     * Unused, and empty, while `output` is empty.
     */
    schema: JsonSchema;
    /** The models the step runs on: the first one on, then each one on after it while the one before cannot take it. */
    models: ModelChoice[];
    /** Each capability adds one tool to the run-scoped MCP server. */
    allowDraftReply: boolean;
    allowMoveEmail: boolean;
    allowSaveAttachments: boolean;
    /**
     * Read, Write, Edit and Bash anywhere on the machine. Off, Claude reads only
     * the workspace's folder and the run folder, writes only through `save_file`,
     * and has no shell.
     */
    allowFileSystem: boolean;
    /**
     * Tools from the workspace's MCP servers, in the SDK's own spelling:
     * `mcp__<server>` for every tool a server has, `mcp__<server>__<tool>` for one.
     * A server none of them names is not started for the run.
     */
    mcpTools: string[];
}

/** Ends a path and records how the email came out. It does nothing to the email: the steps before it do. */
export interface TerminalConfig {
    disposition: Disposition;
}

export type NodeConfig =
    | ({ kind: 'trigger.outlook' } & TriggerConfig)
    | ({ kind: 'categorizer' } & CategorizerConfig)
    | ({ kind: 'extractor' } & ExtractorConfig)
    | ({ kind: 'processor' } & ProcessorConfig)
    | ({ kind: 'terminal' } & TerminalConfig);

export interface FlowNode {
    id: string;
    kind: NodeKind;
    name: string;
    position: { x: number; y: number };
    config: NodeConfig;
}

export interface FlowEdge {
    id: string;
    source: string;
    /** Which output port the edge leaves from — this is what the engine follows. */
    sourceHandle: string;
    target: string;
}

export interface Flow {
    id: string;
    name: string;
    nodes: FlowNode[];
    edges: FlowEdge[];
    updatedAt: string;
}

// ── Ports ────────────────────────────────────────────────────────────────
// Derived from config rather than stored, so no edge can outlive its port.

export type PortTone = 'flow' | 'match' | 'fallback' | 'error';

export interface Port {
    id: string;
    label: string;
    tone: PortTone;
}

export const UNMATCHED_PORT = 'unmatched';

export function outputPorts(node: FlowNode): Port[] {
    switch (node.config.kind) {
        case 'trigger.outlook':
            return [{id: 'out', label: 'On email', tone: 'flow'}];
        case 'categorizer':
            return [
                ...node.config.categories.map(
                    (c): Port => ({id: `cat:${c.id}`, label: c.label || c.id, tone: 'match'}),
                ),
                {id: UNMATCHED_PORT, label: 'Unmatched', tone: 'fallback'},
            ];
        case 'extractor':
            return [
                {id: 'valid', label: 'Valid', tone: 'flow'},
                {id: 'invalid', label: 'Incomplete', tone: 'fallback'},
                {id: 'error', label: 'Error', tone: 'error'},
            ];
        case 'processor':
            return [
                {id: 'done', label: 'Done', tone: 'flow'},
                {id: 'review', label: 'Needs review', tone: 'fallback'},
                {id: 'error', label: 'Error', tone: 'error'},
            ];
        case 'terminal':
            return [];
    }
}

export function hasInput(kind: NodeKind): boolean {
    return kind !== 'trigger.outlook';
}

// ── Data on the wire ─────────────────────────────────────────────────────
// A run carries named slots. A node adds slots and never takes one away, so the
// email is still there for any later step that replies to it or files it.

export type JsonSchema = Record<string, unknown>;

export type SlotType = { kind: 'email' } | { kind: 'json'; schema: JsonSchema };

export interface Slot {
    name: string;
    type: SlotType;
}

/** Every run starts holding this one slot, put there by its trigger. */
export const EMAIL_SLOT: Slot = {name: 'email', type: {kind: 'email'}};

/** A slot name a prompt, a template or a person can write without quoting it. */
export const SLOT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── Named schemas ────────────────────────────────────────────────────────
// Every schema is the workspace's: a file in its `schemas` folder, named once.
// A node's schema in any of its flows only ever stands for one, as
// {"$ref": "#/schemas/<name>"}. So can any field inside a schema, which lets one
// named schema be built out of others. A run fills every reference in before
// the schema is used, so nothing downstream ever sees one.

export type Schemas = Record<string, JsonSchema>;

const SCHEMA_REF = '#/schemas/';

/** A reference to the workspace's schema `name`, as a node or a field holds it. */
export const schemaRef = (name: string): JsonSchema => ({$ref: `${SCHEMA_REF}${name}`});

/** The named schema `schema` stands for, or null when it is not a reference. */
export function refName(schema: unknown): string | null {
    if (!isObject(schema) || typeof schema.$ref !== 'string') return null;
    return schema.$ref.startsWith(SCHEMA_REF) ? schema.$ref.slice(SCHEMA_REF.length) : null;
}

/** `schema` with each reference in it, at any depth, replaced by what `swap` makes of it. */
function mapRefs(schema: unknown, swap: (name: string, ref: Json) => unknown): unknown {
    if (Array.isArray(schema)) return schema.map((item) => mapRefs(item, swap));
    if (!isObject(schema)) return schema;
    const name = refName(schema);
    if (name !== null) return swap(name, schema);
    return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, mapRefs(value, swap)]));
}

/** The named schemas `schema` refers to itself, each once — not the ones those refer to in turn. */
export function schemaRefs(schema: unknown): string[] {
    const names = new Set<string>();
    mapRefs(schema, (name, ref) => {
        names.add(name);
        return ref;
    });
    return [...names];
}

/** The named schema in place of its reference. A key beside `$ref`, such as a field's own description, wins. */
function fillRef(named: JsonSchema, ref: Json): Json {
    const {$ref: _, ...beside} = ref;
    return {...named, ...beside};
}

/** `schema` with every reference in it filled in from `schemas`. Throws, saying why, when one cannot be. */
function resolveSchema(schemas: Schemas, schema: JsonSchema): JsonSchema {
    const fill = (value: unknown, through: string[]): unknown =>
        mapRefs(value, (name, ref) => {
            const named = Object.hasOwn(schemas, name) ? schemas[name] : undefined;
            if (!named) throw new Error(`the workspace has no schema "${name}"`);
            if (through.includes(name)) throw new Error(`"${name}" contains itself (${[...through, name].join(' → ')})`);
            return fillRef(fill(named, [...through, name]) as JsonSchema, ref);
        });
    return fill(schema, []) as JsonSchema;
}

/** Why `schema` cannot be filled in from `schemas`, or null when it can. */
function schemaProblem(schemas: Schemas, schema: JsonSchema): string | null {
    try {
        resolveSchema(schemas, schema);
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/** Whether `schema` uses the named schema `name`, directly or through another named schema. */
function usesSchema(schemas: Schemas, schema: JsonSchema, name: string): boolean {
    const seen = new Set<string>();
    const walk = (value: unknown): boolean => {
        let found = false;
        mapRefs(value, (ref, holder) => {
            if (found || seen.has(ref)) return holder;
            seen.add(ref);
            found = ref === name || (Object.hasOwn(schemas, ref) && walk(schemas[ref]));
            return holder;
        });
        return found;
    };
    return walk(schema);
}

/** The schema a node's result has to match, for the kinds that hand one on; undefined for the rest. */
export function nodeSchema(node: FlowNode): JsonSchema | undefined {
    const config = node.config;
    if (config.kind === 'extractor') return config.schema;
    // A Processor with no output slot fills nothing, so its schema is never used.
    if (config.kind === 'processor' && config.output) return config.schema;
    return undefined;
}

/** `node` with its schema put through `edit`, for the kinds that hold one. */
function editNodeSchema(node: FlowNode, edit: (schema: JsonSchema) => JsonSchema): FlowNode {
    const config = node.config;
    if (config.kind !== 'extractor' && config.kind !== 'processor') return node;
    return {...node, config: {...config, schema: edit(config.schema)}};
}

/**
 * What keeps a node's schema from being used, said as a sentence, or null when
 * nothing does. A node that hands a result on names one of the workspace's
 * schemas; one that names none cannot run.
 */
export function nodeSchemaIssue(schemas: Schemas, node: FlowNode): string | null {
    const schema = nodeSchema(node);
    if (schema === undefined) return null;
    if (refName(schema) === null) {
        return `${node.name} has no schema yet: pick one of the workspace's, or make one with New….`;
    }
    const problem = schemaProblem(schemas, schema);
    return problem && `${node.name}'s schema cannot be used: ${problem}.`;
}

/** `node` with every reference in its schema filled in, as a run needs it. Throws, saying why, when one cannot be. */
export function resolveNode(schemas: Schemas, node: FlowNode): FlowNode {
    if (nodeSchema(node) === undefined) return node;
    return editNodeSchema(node, (schema) => resolveSchema(schemas, schema));
}

/** The nodes of `flow` whose schema uses `name`, directly or through another named schema. */
export function schemaUsers(flow: Flow, schemas: Schemas, name: string): FlowNode[] {
    return flow.nodes.filter((node) => {
        const schema = nodeSchema(node);
        return schema !== undefined && usesSchema(schemas, schema, name);
    });
}

/**
 * Who names the schema `name` itself, each said as a sentence lists it: every
 * node naming it, as “<flow>” (<node>), then every other named schema built from
 * it. Deleting one is refused while this holds anything.
 */
export function schemaHolders(flows: Flow[], schemas: Schemas, name: string): string[] {
    const nodes = flows.flatMap((flow) =>
        flow.nodes
            .filter((node) => 'schema' in node.config && refName(node.config.schema) === name)
            .map((node) => `“${flow.name}” (${node.name})`),
    );
    const holders = Object.entries(schemas)
        .filter(([other, schema]) => other !== name && schemaRefs(schema).includes(name))
        .map(([other]) => `the schema ${other}`);
    return [...nodes, ...holders];
}

/** `schema` with every reference to `from` pointing at `to` instead: a rename, followed. */
export function repointSchema(schema: JsonSchema, from: string, to: string): JsonSchema {
    return mapRefs(schema, (name, ref) => (name === from ? {...ref, $ref: `${SCHEMA_REF}${to}`} : ref)) as JsonSchema;
}

/** `flow` with each node's schema put through `edit`, which is how a rename reaches the flows. */
export function editSchemas(flow: Flow, edit: (schema: JsonSchema) => JsonSchema): Flow {
    return {...flow, nodes: flow.nodes.map((node) => editNodeSchema(node, edit))};
}

/**
 * A slot's type as the canvas and inspector name it: a named schema's name, or
 * "No schema yet" for a node that has picked none.
 */
export function slotTypeLabel(type: SlotType): string {
    if (type.kind === 'email') return 'Email';
    return refName(type.schema) ?? 'No schema yet';
}

/** A schema this module cannot follow into, and so cannot say what it requires. */
const opaque = (schema: unknown): boolean =>
    !isObject(schema) || ['$ref', 'allOf', 'anyOf', 'oneOf'].some((key) => key in schema);

/**
 * Whether `data` falls short of `schema` without the field at `path`, e.g.
 * "items.0.sku": the object that would hold it is in `data`, and its
 * schema lists the field in `required`. A field under an object `data` left out
 * is not needed, and one the schema cannot be followed to counts as needed.
 */
export function needsField(schema: JsonSchema, data: unknown, path: string): boolean {
    const steps = path.split(/[.[\]]+/).filter(Boolean);
    const field = steps.pop();
    if (field === undefined) return true;
    let shape: unknown = schema;
    let holder: unknown = data;
    for (const step of steps) {
        if (opaque(shape)) return true;
        const at = shape as Json;
        if (Array.isArray(holder)) {
            shape = at.items;
            holder = holder[Number(step)];
        } else if (isObject(holder)) {
            const properties = isObject(at.properties) ? at.properties : {};
            shape = Object.hasOwn(properties, step) ? properties[step] : at.additionalProperties;
            holder = holder[step];
        } else {
            return false;
        }
    }
    // An array's items are never in `required`: how many it needs is `minItems`,
    // which the schema check sees for itself.
    if (!isObject(holder)) return false;
    if (opaque(shape)) return true;
    const required = (shape as Json).required;
    return Array.isArray(required) && required.includes(field);
}

/** Slots a node adds to the run when it leaves by `port`. */
export function provides(node: FlowNode, port: string): Slot[] {
    switch (node.config.kind) {
        case 'trigger.outlook':
            return [EMAIL_SLOT];
        case 'extractor':
            // Only Valid promises the data: Incomplete may have left fields out.
            return port === 'valid'
                ? [{name: node.config.output, type: {kind: 'json', schema: node.config.schema}}]
                : [];
        case 'processor':
            // Needs review may stop short of the result, so only Done promises it.
            return port === 'done' && node.config.output
                ? [{name: node.config.output, type: {kind: 'json', schema: node.config.schema}}]
                : [];
        default:
            return [];
    }
}

/** Slots a node cannot run without. */
export function requires(node: FlowNode): string[] {
    switch (node.config.kind) {
        case 'trigger.outlook':
            return [];
        case 'extractor':
            return [EMAIL_SLOT.name, ...node.config.inputs];
        case 'processor':
            return [...(node.config.readEmail ? [EMAIL_SLOT.name] : []), ...node.config.inputs];
        case 'categorizer':
            return [EMAIL_SLOT.name];
        case 'terminal':
            return [];
    }
}

/** Slot name → its type, as guaranteed on arrival at a node. */
export type Available = Map<string, SlotType>;

export interface FlowIssue {
    nodeId: string;
    severity: 'error' | 'warning';
    message: string;
}

export interface SlotCheck {
    /** By node id. A node no trigger reaches has no entry. */
    available: Map<string, Available>;
    issues: FlowIssue[];
}

const typeKey = (type: SlotType): string =>
    type.kind === 'json' ? `json:${JSON.stringify(type.schema)}` : type.kind;

/** The slots both sides hold with the same type. */
function intersect(a: Available, b: Available): Available {
    const out: Available = new Map();
    for (const [name, type] of a) {
        const other = b.get(name);
        if (other && typeKey(other) === typeKey(type)) out.set(name, type);
    }
    return out;
}

/**
 * What every node can count on holding, whichever trigger and path a run took to
 * reach it, and where that falls short of what the node reads. A slot counts only
 * when every path in brings it, so arriving sets are intersected; that only ever
 * shrinks them, which is what lets a flow that loops settle. `schemas` are the
 * workspace's, which a node's schema may name.
 */
export function checkSlots(flow: Flow, schemas: Schemas): SlotCheck {
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    const arriving = new Map<string, Available>();
    const queue: string[] = [];
    for (const trigger of findTriggers(flow)) {
        arriving.set(trigger.id, new Map());
        queue.push(trigger.id);
    }

    while (queue.length > 0) {
        const id = queue.shift()!;
        const node = byId.get(id)!;
        const here = arriving.get(id)!;
        for (const edge of flow.edges) {
            const target = byId.get(edge.target);
            if (edge.source !== id || !target || !hasInput(target.kind)) continue;
            const leaving: Available = new Map(here);
            for (const slot of provides(node, edge.sourceHandle)) leaving.set(slot.name, slot.type);

            const before = arriving.get(edge.target);
            const after = before ? intersect(before, leaving) : leaving;
            if (!before || after.size !== before.size) {
                arriving.set(edge.target, after);
                queue.push(edge.target);
            }
        }
    }

    const issues: FlowIssue[] = [];
    for (const node of flow.nodes) {
        const held = arriving.get(node.id);
        if (!held) continue;
        if (node.kind === 'processor' && requires(node).length === 0) {
            issues.push({
                nodeId: node.id,
                severity: 'error',
                message: `${node.name} reads nothing: give it the email, data from an earlier node, or both.`,
            });
        }
        const schemaIssue = nodeSchemaIssue(schemas, node);
        if (schemaIssue) issues.push({nodeId: node.id, severity: 'error', message: schemaIssue});
        // Put there by a flow file or an agent: the inspector offers Jev to a Categorizer alone.
        if ('models' in node.config && !takesJev(node.kind)) {
            const on = modelsInTurn(node.config.models);
            const jev = on.filter((m) => isJevModel(m.model)).map((m) => m.model);
            if (jev.length > 0) {
                issues.push({
                    nodeId: node.id,
                    severity: jev.length === on.length ? 'error' : 'warning',
                    message: `${node.name} lists ${jev.join(', ')}, but Jev answers a Categorizer's question and nothing else, so the step passes ${jev.length === 1 ? 'it' : 'them'} over.`,
                });
            }
        }
        for (const name of requires(node)) {
            if (held.has(name)) continue;
            issues.push({
                nodeId: node.id,
                severity: 'error',
                message: `${node.name} reads "${name}", but not every path here fills it.`,
            });
        }
        if (node.kind === 'trigger.outlook') continue;
        const overwritten = new Set(
            outputPorts(node).flatMap((port) => provides(node, port.id).map((slot) => slot.name)),
        );
        for (const name of overwritten) {
            if (!held.has(name)) continue;
            issues.push({
                nodeId: node.id,
                severity: 'warning',
                message: `${node.name} overwrites "${name}", which an earlier node already filled.`,
            });
        }
    }
    return {available: arriving, issues};
}

// ── Defaults ─────────────────────────────────────────────────────────────

/** The alias rather than a dated id, so new nodes get the newest Opus the account offers. */
const DEFAULT_MODEL = 'opus';

/** A model stored as `agy:<id>` runs through the Antigravity CLI rather than on Claude. */
export const AGY_MODEL_PREFIX = 'agy:';
export const isAgyModel = (model: string): boolean => model.startsWith(AGY_MODEL_PREFIX);

/**
 * Jev's models — TypeSafe AI's, which answer a question with a probability for
 * each answer rather than write — are stored by their own names: `jev-latest`,
 * `jev-1.14.0`.
 */
export const isJevModel = (model: string): boolean => model.startsWith('jev-');

/** Claude takes every model no other agent claims: its aliases carry no prefix. */
export const isClaudeModel = (model: string): boolean => !isAgyModel(model) && !isJevModel(model);

/** Jev answers a Categorizer's question and nothing else: no other node is offered its models. */
export const takesJev = (kind: NodeKind): boolean => kind === 'categorizer';

/** Of the models the agents offer, the ones a node of this kind can run on. */
export function offeredTo<M extends { value: string }>(kind: NodeKind, offered: readonly M[]): M[] {
    return takesJev(kind) ? [...offered] : offered.filter((m) => !isJevModel(m.value));
}

/** The levels `agy --effort` takes, lowest first. */
export const AGY_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** `agy models` lists a model once per level, as `<id>-<level>`; a run names the two apart. */
export const AGY_LEVEL_SUFFIX = new RegExp(`-(${AGY_LEVELS.join('|')})$`);

/** Of a model the agents offer, what a new node needs to start on it. */
export interface OfferedModel {
    value: string;
    effortLevels: string[];
    effortRequired?: boolean;
}

/**
 * The model a new node starts on, from the models the agents offer it now, listed
 * in Settings' order: the newest Opus when Claude's come first, else the first one
 * offered — agy's or Jev's, where that agent is listed above Claude, or Claude is
 * switched off or not installed. `effort` is the level wanted, kept where the model
 * takes it; otherwise a model that must have one gets its top level. Opus as well
 * while the list is on its way, or when nothing is installed to list any.
 */
export function startingModel(
    offered: readonly OfferedModel[] | null | undefined,
    effort: string,
): Omit<ModelChoice, 'enabled'> {
    const first = offered?.[0];
    if (!first || isClaudeModel(first.value)) return {model: DEFAULT_MODEL, effort};
    const levels = first.effortLevels;
    if (levels.includes(effort)) return {model: first.value, effort};
    return {model: first.value, effort: first.effortRequired ? (levels.at(-1) ?? '') : ''};
}

/** A node's defaults. `offered` is the agents' model list, which picks the model its steps start on. */
export function defaultConfig(kind: NodeKind, offered?: readonly OfferedModel[] | null): NodeConfig {
    const models = (effort: string): ModelChoice[] => [
        {...startingModel(offered && offeredTo(kind, offered), effort), enabled: true},
    ];
    switch (kind) {
        case 'trigger.outlook':
            return {
                kind,
                account: '',
                folders: [''],
                pollSeconds: 60,
                lookbackDays: 1,
                maxPerPoll: 10,
                processBacklogOnStart: false,
            };
        case 'categorizer':
            return {
                kind,
                categories: [
                    {id: 'a', label: 'Category A', description: 'Describe the emails that belong here.'},
                    {id: 'b', label: 'Category B', description: 'Describe the emails that belong here.'},
                ],
                models: models(''),
                includeBody: true,
                bodyMaxChars: 8_000,
            };
        case 'extractor':
            return {
                kind,
                output: 'extracted',
                // Picked, or made, from the workspace's schemas in the inspector.
                schema: {},
                instruction: 'Take each field from what the sender wrote, not from the quoted thread below it.',
                skills: [],
                inputs: [],
                models: models(''),
                includeAttachments: false,
                mcpTools: [],
            };
        case 'processor':
            return {
                kind,
                skills: [],
                instruction: 'Handle this email according to the selected skill.',
                readEmail: true,
                inputs: [],
                output: '',
                schema: {},
                models: models('high'),
                allowDraftReply: false,
                allowMoveEmail: false,
                allowSaveAttachments: true,
                allowFileSystem: false,
                mcpTools: [],
            };
        case 'terminal':
            return {kind, disposition: 'done'};
    }
}

function defaultNodeName(kind: NodeKind): string {
    switch (kind) {
        case 'trigger.outlook':
            return 'Outlook Inbox';
        case 'categorizer':
            return 'Categorize';
        case 'extractor':
            return 'Extract';
        case 'processor':
            return 'Process';
        case 'terminal':
            return 'Done';
    }
}

/** Presentation per node kind. `token` is the kind's CSS name: `.kind-<token>` sets `--k` from `--k-<token>`. */
export const NODE_KIND_META: Record<NodeKind, { label: string; blurb: string; token: string }> = {
    'trigger.outlook': {
        label: 'Outlook Trigger',
        blurb: 'Watches a mailbox folder and starts a run for each new email.',
        token: 'trigger',
    },
    categorizer: {
        label: 'Categorizer',
        blurb: 'Sorts the email down one branch by matching your descriptions.',
        token: 'categorizer',
    },
    extractor: {
        label: 'Extractor',
        blurb: 'Pulls fields out of the email into a JSON shape later nodes can read.',
        token: 'extractor',
    },
    processor: {
        label: 'Processor',
        blurb: 'Runs Claude with the skills you assign, scoped to this email.',
        token: 'processor',
    },
    terminal: {
        label: 'Terminal',
        blurb: 'Ends the path and records how the email came out.',
        token: 'terminal',
    },
};

/** Every trigger in the flow, in file order. A flow may have none, or several. */
export function findTriggers(flow: Flow): FlowNode[] {
    return flow.nodes.filter((n) => n.kind === 'trigger.outlook');
}

/** A trigger's own config, narrowed. Undefined for a node of any other kind. */
export function triggerConfig(node: FlowNode | undefined): TriggerConfig | undefined {
    return node?.config.kind === 'trigger.outlook' ? node.config : undefined;
}

/** A new node with its kind's defaults; `offered`, the agents' model list, picks the model it starts on. */
export function makeNode(
    kind: NodeKind,
    id: string,
    position: { x: number; y: number },
    offered?: readonly OfferedModel[] | null,
): FlowNode {
    return {id, kind, name: defaultNodeName(kind), position, config: defaultConfig(kind, offered)};
}

/** Enough tail to tell two of a kind apart without becoming the name itself. */
export const shortId = (): string => Math.random().toString(36).slice(2, 8);

/** A node id this flow doesn't hold yet, e.g. `processor-4f2ab1`. */
export function mintNodeId(flow: Flow, kind: NodeKind): string {
    const stem = kind.split('.')[0] ?? 'node';
    let id = `${stem}-${shortId()}`;
    while (flow.nodes.some((n) => n.id === id)) id = `${stem}-${shortId()}`;
    return id;
}

/** What an edge is called: derived from its ends, so one wire is never two. */
const edgeId = (source: string, sourceHandle: string, target: string): string =>
    `${source}:${sourceHandle}->${target}`;

/**
 * Connect an output port to a node, replacing the port's existing edge: one edge
 * per port keeps a run's path unambiguous. The port is not validated here.
 */
export function connectNodes(flow: Flow, source: string, sourceHandle: string, target: string): Flow {
    const kept = flow.edges.filter((e) => !(e.source === source && e.sourceHandle === sourceHandle));
    return {
        ...flow,
        edges: [...kept, {id: edgeId(source, sourceHandle, target), source, sourceHandle, target}],
    };
}

/** A blank canvas: a trigger is dragged in from the palette like anything else. */
export function emptyFlow(id: string, name: string): Flow {
    return {id, name, nodes: [], edges: [], updatedAt: new Date().toISOString()};
}

// ── Reading a flow the app did not write ─────────────────────────────────

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback;

const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;

/** A list of strings, keeping only the entries that are strings. */
const strings = (value: unknown, fallback: string[]): string[] =>
    (Array.isArray(value) ? value : fallback).filter((s): s is string => typeof s === 'string');

/** Ticked skills, each once. */
const skillTicks = (value: unknown, fallback: string[]): string[] => [...new Set(strings(value, fallback))];

const oneOf = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;

/** A node's schema: the reference it names, or `{}` until it picks one. */
function schemaOf(value: unknown): JsonSchema {
    const name = refName(value);
    return name === null ? {} : schemaRef(name);
}

/** One of a node's models. */
function modelChoice(from: Json): ModelChoice {
    return {model: str(from.model, ''), effort: str(from.effort, ''), enabled: bool(from.enabled, true)};
}

/**
 * A node's models, keeping only the entries that name one. A list with none on
 * gets its first turned back on: a step needs one to run on.
 */
function modelsOf(value: unknown, base: ModelChoice[]): ModelChoice[] {
    const models = (Array.isArray(value) ? value : [])
        .filter(isObject)
        .map(modelChoice)
        .filter((choice) => choice.model !== '');
    if (models.length === 0) return base;
    return models.some((choice) => choice.enabled)
        ? models
        : models.map((choice, i) => (i === 0 ? {...choice, enabled: true} : choice));
}

/** Every field replaced by its default unless the file supplies the right type. */
function parseConfig(kind: NodeKind, raw: unknown): NodeConfig {
    const base = defaultConfig(kind);
    const from = isObject(raw) ? raw : {};
    switch (base.kind) {
        case 'trigger.outlook':
            return {
                ...base,
                account: str(from.account, base.account),
                folders: strings(from.folders, base.folders),
                pollSeconds: num(from.pollSeconds, base.pollSeconds),
                lookbackDays: num(from.lookbackDays, base.lookbackDays),
                maxPerPoll: num(from.maxPerPoll, base.maxPerPoll),
                processBacklogOnStart: bool(from.processBacklogOnStart, base.processBacklogOnStart),
            };
        case 'categorizer': {
            // Ids name the ports edges leave from, so they have to stay distinct.
            const taken = new Set<string>();
            const categories = (Array.isArray(from.categories) ? from.categories : [])
                .filter(isObject)
                .map((c, i): Category => {
                    const wanted = str(c.id, '') || `c${i + 1}`;
                    let id = wanted;
                    for (let n = 2; taken.has(id); n++) id = `${wanted}-${n}`;
                    taken.add(id);
                    return {id, label: str(c.label, ''), description: str(c.description, '')};
                });
            return {
                ...base,
                categories: categories.length > 0 ? categories : base.categories,
                models: modelsOf(from.models, base.models),
                includeBody: bool(from.includeBody, base.includeBody),
                bodyMaxChars: num(from.bodyMaxChars, base.bodyMaxChars),
            };
        }
        case 'extractor': {
            const output = str(from.output, '');
            return {
                ...base,
                output: SLOT_NAME.test(output) && output !== EMAIL_SLOT.name ? output : base.output,
                schema: schemaOf(from.schema),
                instruction: str(from.instruction, base.instruction),
                skills: skillTicks(from.skills, base.skills),
                inputs: strings(from.inputs, base.inputs),
                models: modelsOf(from.models, base.models),
                includeAttachments: bool(from.includeAttachments, base.includeAttachments),
                mcpTools: strings(from.mcpTools, base.mcpTools),
            };
        }
        case 'processor': {
            const output = str(from.output, '');
            return {
                ...base,
                skills: skillTicks(from.skills, base.skills),
                instruction: str(from.instruction, base.instruction),
                readEmail: bool(from.readEmail, base.readEmail),
                inputs: strings(from.inputs, base.inputs),
                output: SLOT_NAME.test(output) && output !== EMAIL_SLOT.name ? output : base.output,
                schema: schemaOf(from.schema),
                models: modelsOf(from.models, base.models),
                allowDraftReply: bool(from.allowDraftReply, base.allowDraftReply),
                allowMoveEmail: bool(from.allowMoveEmail, base.allowMoveEmail),
                allowSaveAttachments: bool(from.allowSaveAttachments, base.allowSaveAttachments),
                allowFileSystem: bool(from.allowFileSystem, base.allowFileSystem),
                mcpTools: strings(from.mcpTools, base.mcpTools),
            };
        }
        case 'terminal':
            return {
                ...base,
                disposition: oneOf(from.disposition, DISPOSITIONS, base.disposition),
            };
    }
}

/**
 * Rebuild a flow from untrusted JSON (an import, a hand edit, an agent's write).
 * Unknown kinds and duplicate ids are dropped, and an edge survives only if it
 * joins a real output port to a node that takes input.
 */
export function parseFlow(value: unknown, id: string, fallbackName: string): Flow {
    const raw = isObject(value) ? value : {};

    const takenIds = new Set<string>();
    const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).filter(isObject).flatMap(
        (n, i): FlowNode[] => {
            const kind = NODE_KINDS.find((k) => k === n.kind);
            const nodeId = str(n.id, '') || `node-${i + 1}`;
            if (!kind || takenIds.has(nodeId)) return [];
            takenIds.add(nodeId);
            const position = isObject(n.position) ? n.position : {};
            return [
                {
                    id: nodeId,
                    kind,
                    name: str(n.name, '') || defaultNodeName(kind),
                    // Laid out in a row when the file carries no coordinates, so a
                    // flow written by hand still opens as something readable.
                    position: {x: num(position.x, 80 + i * 260), y: num(position.y, 200)},
                    config: parseConfig(kind, n.config),
                },
            ];
        },
    );

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const portsOf = new Map(nodes.map((n) => [n.id, new Set(outputPorts(n).map((p) => p.id))]));
    const takenEdges = new Set<string>();
    const edges = (Array.isArray(raw.edges) ? raw.edges : []).filter(isObject).flatMap(
        (e): FlowEdge[] => {
            const source = str(e.source, '');
            const sourceHandle = str(e.sourceHandle, '');
            const target = str(e.target, '');
            const targetNode = byId.get(target);
            if (!portsOf.get(source)?.has(sourceHandle)) return [];
            if (!targetNode || !hasInput(targetNode.kind)) return [];
            const id = str(e.id, '') || edgeId(source, sourceHandle, target);
            if (takenEdges.has(id)) return [];
            takenEdges.add(id);
            return [{id, source, sourceHandle, target}];
        },
    );

    return {
        id,
        name: str(raw.name, '').trim() || fallbackName,
        nodes,
        edges,
        updatedAt: new Date().toISOString(),
    };
}
