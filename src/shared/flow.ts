/**
 * The flow graph: what the canvas draws, what the engine walks, and what gets
 * written to disk. Renderer and main both import this, so it stays free of any
 * Node or DOM dependency.
 */

export type NodeKind = 'trigger.outlook' | 'categorizer' | 'processor' | 'terminal';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
   * On the first poll after Start, whether mail already sitting in the folder
   * counts as new. Off by default: switching a flow on should not fire a run
   * for every email received last week.
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
  disposition: 'done' | 'needs-review' | 'ignored' | 'failed';
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
// A node's outputs are derived from its config rather than stored, so editing a
// categorizer's categories moves its ports with it and no edge can outlive the
// port it left from (the engine treats a missing port as a dead end).

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
        bodyMaxChars: 8000,
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

export type Theme = 'light' | 'dark';

/**
 * Presentation per node kind. `slug` names the CSS class that carries the
 * kind's accent (`--k`), so a colour is defined once per theme in the
 * stylesheet rather than inline. `accent` is the literal, needed only where a
 * colour must be handed to a canvas that cannot read a CSS variable.
 */
export const NODE_KIND_META: Record<
  NodeKind,
  { label: string; blurb: string; slug: string; accent: Record<Theme, string> }
> = {
  'trigger.outlook': {
    label: 'Outlook Trigger',
    blurb: 'Watches a mailbox folder and starts a run for each new email.',
    slug: 'kind-trigger',
    accent: { light: '#0f9d58', dark: '#4ade80' },
  },
  categorizer: {
    label: 'Categorizer',
    blurb: 'Sorts the email down one branch by matching your descriptions.',
    slug: 'kind-categorizer',
    accent: { light: '#2563eb', dark: '#60a5fa' },
  },
  processor: {
    label: 'Processor',
    blurb: 'Runs Claude with the skills you assign, scoped to this email.',
    slug: 'kind-processor',
    accent: { light: '#7c3aed', dark: '#c084fc' },
  },
  terminal: {
    label: 'Terminal',
    blurb: 'Ends the path and records how the email came out.',
    slug: 'kind-terminal',
    accent: { light: '#64748b', dark: '#94a3b8' },
  },
};

export const accentFor = (kind: NodeKind, theme: Theme): string =>
  NODE_KIND_META[kind].accent[theme];

/** A flow needs exactly one trigger; the engine starts every run there. */
export function findTrigger(flow: Flow): FlowNode | undefined {
  return flow.nodes.find((n) => n.kind === 'trigger.outlook');
}

export function emptyFlow(id: string, name: string): Flow {
  const trigger: FlowNode = {
    id: 'trigger',
    kind: 'trigger.outlook',
    name: defaultNodeName('trigger.outlook'),
    position: { x: 80, y: 220 },
    config: defaultConfig('trigger.outlook'),
  };
  return { id, name, nodes: [trigger], edges: [], updatedAt: new Date().toISOString() };
}
