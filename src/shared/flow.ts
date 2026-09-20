/**
 * The flow graph — drawn by the canvas, walked by the engine, written to disk.
 * Imported by both renderer and main, so it stays free of Node and DOM.
 */

export type NodeKind = 'trigger.outlook' | 'categorizer' | 'processor' | 'terminal';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type Disposition = 'done' | 'needs-review' | 'ignored' | 'failed';

// Listed as values as well as types: the inspector offers them and the importer
// checks against them, and neither should carry its own copy.
export const NODE_KINDS: NodeKind[] = ['trigger.outlook', 'categorizer', 'processor', 'terminal'];
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
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

export interface CategorizerConfig {
    categories: Category[];
    model: string;
    /** Fetch the full body before classifying. Off = subject and preview only. */
    includeBody: boolean;
    bodyMaxChars: number;
}

export interface ProcessorConfig {
    /** Skill names from the app's own library, passed to the Agent SDK. */
    skills: string[];
    /** Free-text instruction prepended to the email context. */
    instruction: string;
    model: string;
    effort: EffortLevel;
    maxTurns: number;
    maxBudgetUsd: number;
    /** Each capability adds one tool to the run-scoped MCP server. */
    allowDraftReply: boolean;
    allowMoveEmail: boolean;
    allowSaveAttachments: boolean;
    /** Read/Write/Edit/Bash inside the workspace directory. */
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
// Derived from config rather than stored, so a categorizer's ports follow its
// categories and no edge can outlive the port it left from.

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
        case 'processor':
            return [
                { id: 'done', label: 'Done', tone: 'flow' },
                { id: 'error', label: 'Error', tone: 'error' },
            ];
        case 'terminal':
            return [];
    }
}

export function hasInput(kind: NodeKind): boolean {
    return kind !== 'trigger.outlook';
}

// ── Defaults ─────────────────────────────────────────────────────────────

export const DEFAULT_MODEL = 'claude-opus-5';

export function defaultConfig(kind: NodeKind): NodeConfig {
    switch (kind) {
        case 'trigger.outlook':
            return {
                kind,
                account: '',
                folder: '',
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
        case 'processor':
            return {
                kind,
                skills: [],
                instruction: 'Handle this email according to the selected skill.',
                model: DEFAULT_MODEL,
                effort: 'high',
                maxTurns: 40,
                maxBudgetUsd: 2,
                allowDraftReply: false,
                allowMoveEmail: false,
                allowSaveAttachments: true,
                allowFileSystem: true,
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
        case 'processor':
            return 'Process';
        case 'terminal':
            return 'Done';
    }
}

/**
 * Presentation per node kind. `token` names the kind in CSS: `.kind-<token>`
 * exposes the accent as `--k` and `--k-<token>` is the accent itself, so every
 * colour stays defined once per theme in the stylesheet.
 */
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

/**
 * Every trigger on the canvas, in the order the file lists them. A flow may hold
 * none — then there is nothing to watch — or several, each polling its own
 * mailbox and starting its own runs.
 */
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

/**
 * An id for a new node that this flow does not already hold: `processor-4f2ab1`.
 * The canvas mints one when a node is dragged on and an agent's `add_node`
 * mints the same shape, so a flow reads the same however it was built.
 */
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
 * Run an edge from one node's output port to another node's input, replacing
 * whatever that port already led to — one edge per port, because a decision
 * leading two places would make the recorded path ambiguous. The port is not
 * checked here: the canvas only offers real ones, the agent tools say which
 * exist before calling, and `parseFlow` drops an edge that names one that does
 * not.
 */
export function connectNodes(flow: Flow, source: string, sourceHandle: string, target: string): Flow {
    const kept = flow.edges.filter((e) => !(e.source === source && e.sourceHandle === sourceHandle));
    return {
        ...flow,
        edges: [...kept, { id: edgeId(source, sourceHandle, target), source, sourceHandle, target }],
    };
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
        case 'processor':
            return {
                ...base,
                skills: (Array.isArray(from.skills) ? from.skills : base.skills).filter(
                    (s): s is string => typeof s === 'string',
                ),
                instruction: str(from.instruction, base.instruction),
                model: str(from.model, base.model),
                effort: oneOf(from.effort, EFFORT_LEVELS, base.effort),
                maxTurns: num(from.maxTurns, base.maxTurns),
                maxBudgetUsd: num(from.maxBudgetUsd, base.maxBudgetUsd),
                allowDraftReply: bool(from.allowDraftReply, base.allowDraftReply),
                allowMoveEmail: bool(from.allowMoveEmail, base.allowMoveEmail),
                allowSaveAttachments: bool(from.allowSaveAttachments, base.allowSaveAttachments),
                allowFileSystem: bool(from.allowFileSystem, base.allowFileSystem),
            };
        case 'terminal':
            return {
                ...base,
                disposition: oneOf(from.disposition, DISPOSITIONS, base.disposition),
                moveToFolder: str(from.moveToFolder, base.moveToFolder),
            };
    }
}

/**
 * Rebuild a flow from unknown JSON — a file exported from another install, or
 * one edited by hand. Anything the engine or canvas would trip over is repaired
 * here rather than mid-run: unknown node kinds and repeated ids are dropped, and
 * an edge survives only if it still joins a real output port to a node that
 * accepts input. However many triggers the file carries — none included — is
 * however many the flow opens with.
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
