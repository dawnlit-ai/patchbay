/**
 * The flow graph — drawn by the canvas, walked by the engine, written to disk.
 * Imported by both renderer and main, so it stays free of Node and DOM.
 */

export type NodeKind = 'trigger.outlook' | 'categorizer' | 'extractor' | 'processor' | 'terminal';

export type Disposition = 'done' | 'needs-review' | 'ignored' | 'failed';

// Listed as values as well as types: the inspector offers them and the importer
// checks against them, and neither should carry its own copy.
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
    /** Inbox subfolder path, e.g. "Pre-Alerts". Empty means the Inbox itself. */
    folder: string;
    /** Watch every folder below `folder` too, for a mailbox whose rules file mail away on arrival. */
    includeSubfolders: boolean;
    /**
     * With `includeSubfolders`: folders to leave out, by name or by path under
     * the Inbox. Each takes everything below it along.
     */
    excludeFolders: string[];
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

/** Where a trigger reads its mail: one folder, or that folder and every folder below it. */
export type MailScope = Pick<TriggerConfig, 'account' | 'folder' | 'includeSubfolders' | 'excludeFolders'>;

export interface CategorizerConfig {
    categories: Category[];
    model: string;
    /** Fetch the full body before classifying. Off = subject and preview only. */
    includeBody: boolean;
    bodyMaxChars: number;
}

export interface ExtractorConfig {
    /** The slot later nodes read the result by, e.g. "shipment". */
    output: string;
    /** JSON Schema the result has to match to leave by Valid. */
    schema: JsonSchema;
    /** What to extract and from where, beyond what the schema's descriptions say. */
    instruction: string;
    model: string;
    /** One of the levels Claude Code lists for this model. Empty uses the model's default. */
    effort: string;
    /** Let it save the attachments and read them, not just the body. */
    includeAttachments: boolean;
}

export interface ProcessorConfig {
    /** Skill names from the app's own library, passed to the Agent SDK. */
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
    /** JSON Schema that result has to match. Unused while `output` is empty. */
    schema: JsonSchema;
    model: string;
    /** One of the levels Claude Code lists for this model (they vary). Empty uses the model's default. */
    effort: string;
    /** Each capability adds one tool to the run-scoped MCP server. */
    allowDraftReply: boolean;
    allowMoveEmail: boolean;
    allowSaveAttachments: boolean;
    /**
     * Read, Write, Edit and Bash anywhere on the machine. Off, Claude reads only
     * the flow's folder and the run folder, writes only through `save_file`, and
     * has no shell — which is what a node reading mail from outside should get.
     */
    allowFileSystem: boolean;
}

export interface TerminalConfig {
    disposition: Disposition;
    /** Inbox subfolder to file the email into on arrival. Empty means leave it. */
    moveToFolder: string;
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
            return [{ id: 'out', label: 'On email', tone: 'flow' }];
        case 'categorizer':
            return [
                ...node.config.categories.map(
                    (c): Port => ({ id: `cat:${c.id}`, label: c.label || c.id, tone: 'match' }),
                ),
                { id: UNMATCHED_PORT, label: 'Unmatched', tone: 'fallback' },
            ];
        case 'extractor':
            return [
                { id: 'valid', label: 'Valid', tone: 'flow' },
                { id: 'invalid', label: 'Incomplete', tone: 'fallback' },
                { id: 'error', label: 'Error', tone: 'error' },
            ];
        case 'processor':
            return [
                { id: 'done', label: 'Done', tone: 'flow' },
                { id: 'review', label: 'Needs review', tone: 'fallback' },
                { id: 'error', label: 'Error', tone: 'error' },
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
// email is still there for the reply or the move at the end of the path.

export type JsonSchema = Record<string, unknown>;

export type SlotType = { kind: 'email' } | { kind: 'json'; schema: JsonSchema };

export interface Slot {
    name: string;
    type: SlotType;
}

/** Every run starts holding this one slot, put there by its trigger. */
export const EMAIL_SLOT: Slot = { name: 'email', type: { kind: 'email' } };

/** A slot name a prompt, a template or a person can write without quoting it. */
export const SLOT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A slot's type as the canvas and inspector name it, e.g. "JSON · 3 fields". */
export function slotTypeLabel(type: SlotType): string {
    if (type.kind === 'email') return 'Email';
    const properties = type.schema.properties;
    if (typeof properties !== 'object' || properties === null) return 'JSON';
    const count = Object.keys(properties).length;
    return `JSON · ${count} field${count === 1 ? '' : 's'}`;
}

/** Slots a node adds to the run when it leaves by `port`. */
export function provides(node: FlowNode, port: string): Slot[] {
    switch (node.config.kind) {
        case 'trigger.outlook':
            return [EMAIL_SLOT];
        case 'extractor':
            // Only Valid promises the data: Incomplete may have left fields out.
            return port === 'valid'
                ? [{ name: node.config.output, type: { kind: 'json', schema: node.config.schema } }]
                : [];
        case 'processor':
            // Needs review may stop short of the result, so only Done promises it.
            return port === 'done' && node.config.output
                ? [{ name: node.config.output, type: { kind: 'json', schema: node.config.schema } }]
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
        case 'processor':
            return [...(node.config.readEmail ? [EMAIL_SLOT.name] : []), ...node.config.inputs];
        default:
            return [EMAIL_SLOT.name];
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
 * shrinks them, which is what lets a flow that loops settle.
 */
export function checkSlots(flow: Flow): SlotCheck {
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
        if (requires(node).length === 0 && hasInput(node.kind)) {
            issues.push({
                nodeId: node.id,
                severity: 'error',
                message: `${node.name} reads nothing: give it the email, data from an earlier node, or both.`,
            });
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
    return { available: arriving, issues };
}

// ── Defaults ─────────────────────────────────────────────────────────────

/**
 * The alias rather than a dated id: Claude Code resolves it to the newest Opus the
 * account offers, so a node made today does not stay pinned to today's model.
 */
export const DEFAULT_MODEL = 'opus';

export function defaultConfig(kind: NodeKind): NodeConfig {
    switch (kind) {
        case 'trigger.outlook':
            return {
                kind,
                account: '',
                folder: '',
                includeSubfolders: false,
                excludeFolders: [],
                pollSeconds: 60,
                lookbackDays: 1,
                maxPerPoll: 10,
                processBacklogOnStart: false,
            };
        case 'categorizer':
            return {
                kind,
                categories: [
                    { id: 'a', label: 'Category A', description: 'Describe the emails that belong here.' },
                    { id: 'b', label: 'Category B', description: 'Describe the emails that belong here.' },
                ],
                model: DEFAULT_MODEL,
                includeBody: true,
                bodyMaxChars: 8_000,
            };
        case 'extractor':
            return {
                kind,
                output: 'extracted',
                schema: {
                    type: 'object',
                    properties: {
                        reference: {
                            type: 'string',
                            description: 'The shipment, order or booking reference the email is about.',
                        },
                    },
                    required: ['reference'],
                },
                instruction: 'Take each field from what the sender wrote, not from the quoted thread below it.',
                model: DEFAULT_MODEL,
                effort: '',
                includeAttachments: false,
            };
        case 'processor':
            return {
                kind,
                skills: [],
                instruction: 'Handle this email according to the selected skill.',
                readEmail: true,
                inputs: [],
                output: '',
                schema: { type: 'object', properties: {} },
                model: DEFAULT_MODEL,
                effort: 'high',
                allowDraftReply: false,
                allowMoveEmail: false,
                allowSaveAttachments: true,
                allowFileSystem: false,
            };
        case 'terminal':
            return { kind, disposition: 'done', moveToFolder: '' };
    }
}

export function defaultNodeName(kind: NodeKind): string {
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

/** A node of `kind` with its defaults — dropped on the canvas, seeded, or repaired. */
export function makeNode(kind: NodeKind, id: string, position: { x: number; y: number }): FlowNode {
    return { id, kind, name: defaultNodeName(kind), position, config: defaultConfig(kind) };
}

/** Enough tail to tell two of a kind apart without becoming the name itself. */
export const shortId = (): string => Math.random().toString(36).slice(2, 8);

/** A node id this flow doesn't hold yet, e.g. `processor-4f2ab1`. Used by both the canvas and `add_node`. */
export function mintNodeId(flow: Flow, kind: NodeKind): string {
    const stem = kind.split('.')[0] ?? 'node';
    let id = `${stem}-${shortId()}`;
    while (flow.nodes.some((n) => n.id === id)) id = `${stem}-${shortId()}`;
    return id;
}

/** What an edge is called: derived from its ends, so one wire is never two. */
export const edgeId = (source: string, sourceHandle: string, target: string): string =>
    `${source}:${sourceHandle}->${target}`;

/**
 * Connect an output port to a node, replacing the port's existing edge: one edge
 * per port keeps a run's path unambiguous. The port is not validated here.
 */
export function connectNodes(flow: Flow, source: string, sourceHandle: string, target: string): Flow {
    const kept = flow.edges.filter((e) => !(e.source === source && e.sourceHandle === sourceHandle));
    return {
        ...flow,
        edges: [...kept, { id: edgeId(source, sourceHandle, target), source, sourceHandle, target }],
    };
}

/**
 * Re-point every Processor ticking `before` at `after`, as when a skill changes
 * library. Returns the same flow object when nothing changed.
 */
export function retickSkill(flow: Flow, before: string, after: string): Flow {
    let changed = false;
    const nodes = flow.nodes.map((node) => {
        if (node.config.kind !== 'processor') return node;
        if (!node.config.skills.includes(before)) return node;
        changed = true;
        // Through a Set: a node ticking both libraries' copies would otherwise
        // end up ticking the survivor twice.
        const skills = [...new Set(node.config.skills.map((s) => (s === before ? after : s)))];
        return { ...node, config: { ...node.config, skills } };
    });
    return changed ? { ...flow, nodes } : flow;
}

/** Whether any Processor in the flow ticks this skill. */
export function ticksSkill(flow: Flow, ref: string): boolean {
    return flow.nodes.some((node) => node.config.kind === 'processor' && node.config.skills.includes(ref));
}

/** A blank canvas: a trigger is dragged in from the palette like anything else. */
export function emptyFlow(id: string, name: string): Flow {
    return { id, name, nodes: [], edges: [], updatedAt: new Date().toISOString() };
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

const oneOf = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;

/** Every field replaced by its default unless the file supplies the right type. */
function parseConfig(kind: NodeKind, raw: unknown): NodeConfig {
    const base = defaultConfig(kind);
    const from = isObject(raw) ? raw : {};
    switch (base.kind) {
        case 'trigger.outlook':
            return {
                ...base,
                account: str(from.account, base.account),
                folder: str(from.folder, base.folder),
                includeSubfolders: bool(from.includeSubfolders, base.includeSubfolders),
                excludeFolders: strings(from.excludeFolders, base.excludeFolders),
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
                    return { id, label: str(c.label, ''), description: str(c.description, '') };
                });
            return {
                ...base,
                categories: categories.length > 0 ? categories : base.categories,
                model: str(from.model, base.model),
                includeBody: bool(from.includeBody, base.includeBody),
                bodyMaxChars: num(from.bodyMaxChars, base.bodyMaxChars),
            };
        }
        case 'extractor': {
            const output = str(from.output, '');
            return {
                ...base,
                output: SLOT_NAME.test(output) && output !== EMAIL_SLOT.name ? output : base.output,
                schema: isObject(from.schema) ? from.schema : base.schema,
                instruction: str(from.instruction, base.instruction),
                model: str(from.model, base.model),
                effort: str(from.effort, base.effort),
                includeAttachments: bool(from.includeAttachments, base.includeAttachments),
            };
        }
        case 'processor': {
            const output = str(from.output, '');
            return {
                ...base,
                skills: strings(from.skills, base.skills),
                instruction: str(from.instruction, base.instruction),
                readEmail: bool(from.readEmail, base.readEmail),
                inputs: strings(from.inputs, base.inputs),
                output: SLOT_NAME.test(output) && output !== EMAIL_SLOT.name ? output : base.output,
                schema: isObject(from.schema) ? from.schema : base.schema,
                model: str(from.model, base.model),
                effort: str(from.effort, base.effort),
                allowDraftReply: bool(from.allowDraftReply, base.allowDraftReply),
                allowMoveEmail: bool(from.allowMoveEmail, base.allowMoveEmail),
                allowSaveAttachments: bool(from.allowSaveAttachments, base.allowSaveAttachments),
                allowFileSystem: bool(from.allowFileSystem, base.allowFileSystem),
            };
        }
        case 'terminal':
            return {
                ...base,
                disposition: oneOf(from.disposition, DISPOSITIONS, base.disposition),
                moveToFolder: str(from.moveToFolder, base.moveToFolder),
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
                    position: { x: num(position.x, 80 + i * 260), y: num(position.y, 200) },
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
            return [{ id, source, sourceHandle, target }];
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
