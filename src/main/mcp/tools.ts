import { app } from 'electron';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    connectNodes,
    type Flow,
    type FlowNode,
    makeNode,
    mintNodeId,
    NODE_KINDS,
    type NodeConfig,
    outputPorts,
    parseFlow,
    triggerConfig,
} from '@shared/flow';
import { SKILL_SCOPES, type SkillScope } from '@shared/settings';
import type { WorkspaceChange } from '@shared/ipc';
import { type EmailEnvelope, type Run, truncate } from '@shared/trace';
import type { Watcher } from '../engine/watcher';
import * as outlook from '../outlook/bridge';
import * as flowStore from '../store/flowStore';
import * as skillStore from '../store/skillStore';
import * as traceStore from '../store/traceStore';
import { getSettings } from '../store/settingsStore';

/**
 * The app as a set of MCP tools, so an agent outside the window can do what the
 * person at it does. Every one of these goes through the same store the window
 * uses, so the two are editing one workspace rather than two copies of it —
 * which is why every write says what it changed, and the window re-reads it.
 *
 * What is missing is as much of the design as what is here:
 *
 * - **No tool reaches into the mailbox for a message.** An agent lists what is in
 *   a folder in order to pick one to test against; fetching a body is for the
 *   run's own scoped tools. A run already recorded is another matter — its trace
 *   holds the whole prompt, because a record you cannot read is not a record.
 * - **No tool writes settings.** The Claude executable and the MCP servers
 *   handed to a Processor decide what code a run executes, so they stay with
 *   the person at the window.
 * - **Nothing here sends mail.** Nothing in this app does.
 */

export interface AgentHost {
    /** The watcher the window drives, so both start and stop the same poller. */
    watcher(): Watcher;

    /** Something an agent wrote is now on disk; the window is told to re-read it. */
    changed(change: WorkspaceChange): void;
}

/** How far back the tools that offer a real email to run against look. */
const LOOKBACK_DAYS = 7;

/** A pass's events carry whole prompts and tool payloads; trimmed, not dropped. */
const MAX_DETAIL_CHARS = 4_000;

export const INSTRUCTIONS = `Patchbay wires email-processing flows on a canvas.

A flow is a graph. Every node hands the email out of exactly one output port and
the engine follows the single edge attached to it, so a run is a readable path
rather than a fan-out. The four node kinds:

- trigger.outlook — watches one mailbox folder and starts a run per new email.
- categorizer     — an if/else written in prose: each category is an output port
                    and Claude picks exactly one, with an "unmatched" port for
                    the rest.
- processor       — runs Claude with the skills it ticks, scoped to one email.
                    Ports: "done" and "error".
- terminal        — ends the path and records how the email came out.

Work in this order: list_flows, then get_flow to see the ports a node actually
has, then add_node / update_node / connect. Ports are derived from configuration
rather than stored, so editing a categorizer's categories moves its ports — an
edge left hanging by that is dropped, and the tool result says how many.

Before telling the person it works, run it: test_run puts one real email through
the flow, and get_run returns the trace, including why each node left by the port
it did.`;

// ── Results ──────────────────────────────────────────────────────────────

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const json = (value: unknown) => text(JSON.stringify(value, null, 2));

// ── Reading the workspace ────────────────────────────────────────────────

function requireFlow(flowId: string): Flow {
    const flow = flowStore.getFlow(flowId);
    if (!flow) throw new Error(`There is no flow "${flowId}". list_flows gives the ids this install holds.`);
    return flow;
}

function requireNode(flow: Flow, nodeId: string): FlowNode {
    const node = flow.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`"${flow.name}" has no node "${nodeId}". get_flow lists them.`);
    return node;
}

/** A node with the ports its configuration gives it, and where each one leads. */
function describeNode(flow: Flow, node: FlowNode) {
    return {
        id: node.id,
        kind: node.kind,
        name: node.name,
        position: node.position,
        config: node.config,
        outputs: outputPorts(node).map((port) => ({
            port: port.id,
            label: port.label,
            connectedTo:
                flow.edges.find((e) => e.source === node.id && e.sourceHandle === port.id)?.target ?? null,
        })),
    };
}

const describeFlow = (flow: Flow) => ({
    id: flow.id,
    name: flow.name,
    updatedAt: flow.updatedAt,
    nodes: flow.nodes.map((node) => describeNode(flow, node)),
    edges: flow.edges,
});

/** Enough of an email to choose one, and nothing of what it says. */
const describeEmail = (email: EmailEnvelope) => ({
    entryId: email.ref.entryId,
    subject: email.subject,
    senderName: email.senderName,
    senderEmail: email.senderEmail,
    receivedTime: email.receivedTime,
    attachmentNames: email.attachmentNames,
    preview: email.bodyPreview.slice(0, 400),
});

function describeRun(run: Run, includeEvents: boolean) {
    return {
        ...run,
        passes: run.passes.map((pass) => ({
            ...pass,
            eventCount: pass.events.length,
            events: includeEvents
                ? pass.events.map((event) => ({
                    ...event,
                    detail: event.detail === undefined ? undefined : truncate(event.detail, MAX_DETAIL_CHARS),
                }))
                : [],
        })),
    };
}

// ── Writing the workspace ────────────────────────────────────────────────

/**
 * Apply an edit and put the result through the same repair an imported file
 * gets. An agent is a writer the app has not vetted, so what it hands back is
 * checked the way a flow from another install is: a value of the wrong type
 * falls back to that field's default, and an edge whose port the edit removed is
 * dropped here rather than found mid-run. The caller reports that count, because
 * an edge quietly disappearing is exactly the surprise this app tries not to
 * spring.
 */
function editFlow(host: AgentHost, flowId: string, edit: (flow: Flow) => Flow) {
    const before = requireFlow(flowId);
    const edited = edit(before);
    const flow = flowStore.saveFlow(parseFlow(edited, before.id, before.name));
    host.changed({ flows: true, skills: false });
    return { flow, droppedEdges: edited.edges.length - flow.edges.length };
}

/** `flowId` is read only for a flow's own library; the global one is shared. */
function libraryOf(scope: SkillScope, flowId?: string): string {
    if (scope === 'global') return '';
    if (!flowId) throw new Error('A flow-scoped skill needs the flowId of the flow whose library holds it.');
    return requireFlow(flowId).id;
}

// ── The surface ──────────────────────────────────────────────────────────

const flowIdArg = z.string().describe('Flow id, from list_flows.');

const scopeArg = z
    .enum(SKILL_SCOPES)
    .describe('"global" is the shelf every flow can tick; "flow" belongs to one flow and travels with it.');

/** Registers every tool on a server. Called once per request, on a fresh one. */
export function registerAgentTools(server: McpServer, host: AgentHost): void {
    // ── Flows ────────────────────────────────────────────────────────────

    server.registerTool(
        'list_flows',
        {
            title: 'List flows',
            description:
                'Every flow in this install, with its id, its size, when it was last written and the directory it lives in — which is the working directory its nodes run in.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
        },
        () =>
            json(
                flowStore.listFlowEntries().map(({ flow, folder, path }) => ({
                    id: flow.id,
                    name: flow.name,
                    updatedAt: flow.updatedAt,
                    nodeCount: flow.nodes.length,
                    edgeCount: flow.edges.length,
                    folder,
                    path,
                })),
            ),
    );

    server.registerTool(
        'get_flow',
        {
            title: 'Get a flow',
            description:
                'One flow in full: every node with its configuration, the output ports that configuration gives it, and what each port is wired to.',
            inputSchema: { flowId: flowIdArg },
            annotations: { readOnlyHint: true },
        },
        ({ flowId }) => json(describeFlow(requireFlow(flowId))),
    );

    server.registerTool(
        'create_flow',
        {
            title: 'Create a flow',
            description: 'Start an empty flow. Nodes go on it with add_node.',
            inputSchema: { name: z.string().min(1) },
        },
        ({ name }) => {
            const flow = flowStore.createFlow(name);
            host.changed({ flows: true, skills: false });
            return json(describeFlow(flow));
        },
    );

    server.registerTool(
        'rename_flow',
        {
            title: 'Rename a flow',
            description: 'Change what a flow is called. Its id, its graph and its skills are untouched.',
            inputSchema: { flowId: flowIdArg, name: z.string().min(1) },
        },
        ({ flowId, name }) => json(describeFlow(editFlow(host, flowId, (flow) => ({ ...flow, name })).flow)),
    );

    server.registerTool(
        'delete_flow',
        {
            title: 'Delete a flow',
            description:
                'Delete a flow, the skill library belonging to it and the watcher marks that go with it. Nothing in the app undoes this, so ask the person first.',
            inputSchema: { flowId: flowIdArg },
            annotations: { destructiveHint: true, idempotentHint: true },
        },
        ({ flowId }) => {
            const flow = requireFlow(flowId);
            flowStore.removeFlow(flow.id);
            host.changed({ flows: true, skills: true });
            return text(`Deleted "${flow.name}".`);
        },
    );

    // ── Nodes and edges ──────────────────────────────────────────────────

    server.registerTool(
        'add_node',
        {
            title: 'Add a node',
            description:
                'Put a node on the canvas with its defaults, to be configured with update_node. Returns the node, the output ports it now has included.',
            inputSchema: {
                flowId: flowIdArg,
                kind: z.enum(NODE_KINDS),
                name: z.string().optional().describe('Shown on the canvas. Defaults to the kind’s own name.'),
                x: z.number().optional(),
                y: z.number().optional(),
            },
        },
        ({ flowId, kind, name, x, y }) => {
            const id = mintNodeId(requireFlow(flowId), kind);
            const { flow } = editFlow(host, flowId, (current) => {
                // Placed to the right of everything already there, so a flow built
                // entirely through these tools still opens as something readable.
                const right = current.nodes.reduce((max, n) => Math.max(max, n.position.x), -180);
                const node = makeNode(kind, id, { x: x ?? right + 260, y: y ?? 200 });
                return { ...current, nodes: [...current.nodes, name ? { ...node, name } : node] };
            });
            return json(describeNode(flow, requireNode(flow, id)));
        },
    );

    server.registerTool(
        'update_node',
        {
            title: 'Configure a node',
            description:
                'Change a node’s name, position or configuration. `config` is merged over what the node holds, so pass only the fields you are changing; a value of the wrong type falls back to that field’s default, and the result shows what actually stuck. Editing a categorizer’s categories moves its ports.',
            inputSchema: {
                flowId: flowIdArg,
                nodeId: z.string(),
                name: z.string().optional(),
                x: z.number().optional(),
                y: z.number().optional(),
                config: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe('Partial node configuration. get_flow shows the shape this kind takes.'),
            },
        },
        ({ flowId, nodeId, name, x, y, config }) => {
            const { flow, droppedEdges } = editFlow(host, flowId, (current) => {
                const node = requireNode(current, nodeId);
                const next: FlowNode = {
                    ...node,
                    name: name ?? node.name,
                    position: { x: x ?? node.position.x, y: y ?? node.position.y },
                    // Asserted rather than proved: a merged patch is exactly the
                    // unvetted shape `parseFlow` exists to repair, and it runs on the
                    // way out. `kind` goes on last, so no patch turns one kind of node
                    // into another.
                    config: { ...node.config, ...config, kind: node.config.kind } as NodeConfig,
                };
                return { ...current, nodes: current.nodes.map((n) => (n.id === nodeId ? next : n)) };
            });
            return json({
                node: describeNode(flow, requireNode(flow, nodeId)),
                droppedEdges,
                note:
                    droppedEdges > 0
                        ? `${droppedEdges} edge(s) left a port this node no longer has, and were removed.`
                        : undefined,
            });
        },
    );

    server.registerTool(
        'remove_node',
        {
            title: 'Remove a node',
            description: 'Take a node off the canvas, along with every edge into or out of it.',
            inputSchema: { flowId: flowIdArg, nodeId: z.string() },
            annotations: { destructiveHint: true, idempotentHint: true },
        },
        ({ flowId, nodeId }) => {
            const { flow, droppedEdges } = editFlow(host, flowId, (current) => {
                requireNode(current, nodeId);
                return { ...current, nodes: current.nodes.filter((n) => n.id !== nodeId) };
            });
            return json({ flow: describeFlow(flow), droppedEdges });
        },
    );

    server.registerTool(
        'connect',
        {
            title: 'Connect two nodes',
            description:
                'Run an edge from one node’s output port to another node’s input. One edge per port: connecting a port that already leads somewhere replaces that edge, because a decision leading two places would make the recorded path ambiguous.',
            inputSchema: {
                flowId: flowIdArg,
                from: z.string().describe('Source node id.'),
                port: z
                    .string()
                    .describe('Output port on the source node, e.g. "done", "out" or "cat:pre-alert".'),
                to: z.string().describe('Target node id.'),
            },
        },
        ({ flowId, from, port, to }) => {
            const { flow } = editFlow(host, flowId, (current) => {
                const source = requireNode(current, from);
                requireNode(current, to);
                if (from === to) throw new Error('A node cannot connect to itself.');
                const ports = outputPorts(source);
                if (!ports.some((p) => p.id === port)) {
                    throw new Error(
                        `"${source.name}" has no port "${port}". It has: ${ports.map((p) => p.id).join(', ') || '(none — it ends the path)'}`,
                    );
                }
                return connectNodes(current, from, port, to);
            });
            return json(describeFlow(flow));
        },
    );

    server.registerTool(
        'disconnect',
        {
            title: 'Cut a connection',
            description: 'Remove one edge by id. The nodes it joined stay where they are.',
            inputSchema: { flowId: flowIdArg, edgeId: z.string() },
            annotations: { idempotentHint: true },
        },
        ({ flowId, edgeId }) => {
            const { flow } = editFlow(host, flowId, (current) => ({
                ...current,
                edges: current.edges.filter((e) => e.id !== edgeId),
            }));
            return json(describeFlow(flow));
        },
    );

    // ── Skills ───────────────────────────────────────────────────────────

    server.registerTool(
        'list_skills',
        {
            title: 'List skills',
            description:
                'Both libraries at once — the global shelf and this flow’s own. A Processor ticks a global skill as "global:<name>" and one of the flow’s own by its bare name.',
            inputSchema: { flowId: flowIdArg },
            annotations: { readOnlyHint: true },
        },
        ({ flowId }) => json(skillStore.listAllSkills(requireFlow(flowId).id)),
    );

    server.registerTool(
        'get_skill',
        {
            title: 'Read a skill',
            description: 'The whole SKILL.md, frontmatter included.',
            inputSchema: { scope: scopeArg, name: z.string(), flowId: z.string().optional() },
            annotations: { readOnlyHint: true },
        },
        ({ scope, name, flowId }) => {
            const skill = skillStore.getSkill(scope, libraryOf(scope, flowId), name);
            if (!skill) throw new Error(`There is no ${scope} skill "${name}".`);
            return json(skill);
        },
    );

    server.registerTool(
        'write_skill',
        {
            title: 'Write a skill',
            description:
                'Create or replace a SKILL.md in one of the libraries. Write the whole file: a `---` frontmatter block carrying `name` and `description`, then the instructions. The name has to be lowercase letters, digits and hyphens, because it becomes both a folder and a Claude skill identifier.',
            inputSchema: {
                scope: scopeArg,
                name: z.string(),
                content: z.string().min(1),
                flowId: z.string().optional(),
            },
        },
        ({ scope, name, content, flowId }) => {
            const summary = skillStore.saveSkill(scope, libraryOf(scope, flowId), name, content);
            host.changed({ flows: false, skills: true });
            const front = skillStore.parseFrontmatter(content);
            return json({
                ...summary,
                warning:
                    front.name && front.description
                        ? undefined
                        : 'The frontmatter is missing a name or a description. Claude matches a skill on its description, so this one will be hard to reach.',
            });
        },
    );

    server.registerTool(
        'delete_skill',
        {
            title: 'Delete a skill',
            description:
                'Remove a skill folder. A global one goes for every flow in this install, and any Processor still ticking it then names a skill that is not there.',
            inputSchema: { scope: scopeArg, name: z.string(), flowId: z.string().optional() },
            annotations: { destructiveHint: true, idempotentHint: true },
        },
        ({ scope, name, flowId }) => {
            skillStore.removeSkill(scope, libraryOf(scope, flowId), name);
            host.changed({ flows: false, skills: true });
            return text(`Deleted the ${scope} skill "${name}".`);
        },
    );

    // ── The mailbox, as far as choosing an email ─────────────────────────

    server.registerTool(
        'list_accounts',
        {
            title: 'List Outlook accounts',
            description: 'The accounts the desktop Outlook client on this machine is signed in to.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
        },
        async () => json(await outlook.getAccounts()),
    );

    server.registerTool(
        'list_folders',
        {
            title: 'List mailbox folders',
            description:
                'Inbox subfolders for one account. `relativePath` is what a trigger stores in its `folder` field, and the Inbox itself is the empty string.',
            inputSchema: { account: z.string() },
            annotations: { readOnlyHint: true },
        },
        async ({ account }) => json(await outlook.listFolders(account)),
    );

    server.registerTool(
        'list_recent_emails',
        {
            title: 'List recent emails',
            description:
                'Recent mail in a folder — subject, sender and a short preview — so a real message can be picked for test_run. Nothing here fetches a body out of Outlook: that is for the scoped tools of the run that handles it.',
            inputSchema: {
                account: z.string(),
                folder: z.string().optional().describe('Path relative to the Inbox. Empty means the Inbox.'),
                limit: z.number().int().min(1).max(50).optional(),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ account, folder, limit }) => {
            const emails = await outlook.readInbox(account, folder ?? '', LOOKBACK_DAYS, limit ?? 20);
            return json(emails.map(describeEmail));
        },
    );

    // ── Running ──────────────────────────────────────────────────────────

    server.registerTool(
        'get_status',
        {
            title: 'Engine status',
            description:
                'Whether the poller is running, which triggers it is watching, when it last polled and what is running now.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
        },
        () => json(host.watcher().status()),
    );

    server.registerTool(
        'start_watching',
        {
            title: 'Start watching',
            description:
                'Switch the poller on. Every trigger that names a mailbox starts polling it, and mail that arrives starts real runs that cost real money.',
            inputSchema: {},
        },
        () => json(host.watcher().start()),
    );

    server.registerTool(
        'stop_watching',
        {
            title: 'Stop watching',
            description: 'Switch the poller off. A run already under way is left to finish.',
            inputSchema: {},
            annotations: { idempotentHint: true },
        },
        () => json(host.watcher().stop()),
    );

    server.registerTool(
        'test_run',
        {
            title: 'Test a flow against one email',
            description:
                'Put one real email through a flow now, ignoring the watermark, starting at the trigger named. Without an entryId the newest message in that trigger’s folder is used. This calls Claude and costs money, and a Processor with drafting or filing switched on will act on the mailbox. Returns the run id; get_run has the trace.',
            inputSchema: {
                flowId: flowIdArg,
                nodeId: z.string().describe('The trigger to start from — a flow may have several.'),
                entryId: z.string().optional().describe('From list_recent_emails.'),
            },
        },
        async ({ flowId, nodeId, entryId }) => {
            const flow = requireFlow(flowId);
            const node = flow.nodes.find((n) => n.id === nodeId);
            const config = triggerConfig(node);
            if (!node || !config) {
                throw new Error(`"${nodeId}" is not a trigger in "${flow.name}", and a run starts at a trigger.`);
            }
            if (!config.account.trim()) {
                throw new Error(`"${node.name}" names no mailbox yet. Give it an account with update_node first.`);
            }
            const recent = await outlook.readInbox(config.account, config.folder, LOOKBACK_DAYS, 50);
            const email = entryId ? recent.find((e) => e.ref.entryId === entryId) : recent[0];
            if (!email) {
                throw new Error(
                    entryId
                        ? `No email with entryId "${entryId}" in the last ${LOOKBACK_DAYS} days of that folder.`
                        : `Nothing in the last ${LOOKBACK_DAYS} days of that folder to test against.`,
                );
            }
            const runId = host.watcher().enqueueManual(flow.id, node.id, email);
            return json({ runId, email: describeEmail(email), note: 'Queued. Poll get_run for the trace.' });
        },
    );

    server.registerTool(
        'cancel_run',
        {
            title: 'Cancel a run',
            description: 'Abort a run still under way. The trace up to that point is kept.',
            inputSchema: { runId: z.string() },
            annotations: { idempotentHint: true },
        },
        ({ runId }) => {
            host.watcher().cancel(runId);
            return text(`Asked run ${runId} to stop.`);
        },
    );

    server.registerTool(
        'list_runs',
        {
            title: 'List runs',
            description: 'Recent runs, newest first: what each handled, how it ended and what it cost.',
            inputSchema: {
                limit: z.number().int().min(1).max(200).optional(),
                flowId: z.string().optional().describe('Only runs of this flow.'),
            },
            annotations: { readOnlyHint: true },
        },
        ({ limit, flowId }) => {
            const wanted = limit ?? 20;
            if (!flowId) return json(traceStore.listRuns(wanted));
            // Filtered after the walk, so a flow that has not run lately still costs
            // one bounded read of the index rather than the whole of it.
            return json(traceStore.listRuns(500).filter((run) => run.flowId === flowId).slice(0, wanted));
        },
    );

    server.registerTool(
        'get_run',
        {
            title: 'Read a run',
            description:
                'One run in full: the path it took and, per node, the port it left by, the one-line reason, every prompt and tool call, and the cost. This is where you find out why an email went where it did — and, since a prompt carries the email it was about, where a handled message can be read back.',
            inputSchema: {
                runId: z.string(),
                includeEvents: z
                    .boolean()
                    .optional()
                    .describe('Default true. False keeps the passes and their outcomes but drops the detail.'),
            },
            annotations: { readOnlyHint: true },
        },
        ({ runId, includeEvents }) => {
            const run = traceStore.getRun(runId);
            if (!run) throw new Error(`There is no run "${runId}".`);
            return json(describeRun(run, includeEvents !== false));
        },
    );

    // ── Settings, read only ──────────────────────────────────────────────

    server.registerTool(
        'get_settings',
        {
            title: 'Read settings',
            description:
                'App settings, with the agent-control token withheld. There is no tool that writes these: the Claude executable and the MCP servers handed to a Processor decide what code a run can execute, so they stay with the person at the window.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
        },
        () => {
            const settings = getSettings();
            return json({
                appVersion: app.getVersion(),
                ...settings,
                agentControl: { ...settings.agentControl, token: '(withheld)' },
            });
        },
    );
}
