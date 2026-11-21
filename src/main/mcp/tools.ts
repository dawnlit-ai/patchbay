import { app } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    checkSlots,
    connectNodes,
    type Flow,
    type FlowNode,
    makeNode,
    mintNodeId,
    NODE_KINDS,
    type NodeConfig,
    type OfferedModel,
    outputPorts,
    parseFlow,
    refName,
    schemaUsers,
    SLOT_NAME,
    triggerConfig,
} from '@shared/flow';
import { LOG_LEVELS, LOG_SOURCES } from '@shared/log';
import type { WorkspaceChange } from '@shared/ipc';
import { type EmailEnvelope, type Pass, type Run, toSummary, truncate } from '@shared/trace';
import { isObject } from '@shared/util';
import type { QueuedRun, Watcher } from '../engine/watcher';
import { logEntries, logEntriesOn } from '../log';
import * as outlook from '../outlook/bridge';
import * as flowStore from '../store/flowStore';
import { listMcpServers } from '../store/mcpStore';
import * as schemaStore from '../store/schemaStore';
import * as skillStore from '../store/skillStore';
import { rewatch } from '../store/folderWatch';
import { flowsDirAt, schemasDirAt, skillsDirAt, workspaceRoot } from '../paths';
import { readmeFile } from '../store/workspaceStore';
import * as traceStore from '../store/traceStore';
import { getSettings } from '../store/settingsStore';
import { listServerTools } from '../tools/serverTools';

/**
 * The app as MCP tools, going through the same stores as the window; every write
 * reports what it changed so the window can re-read it. Deliberately absent: no
 * tool fetches a message body (that is for a run's scoped tools), none writes
 * settings (they decide what code a run executes), and none sends mail.
 */

export interface AgentHost {
    /** The watcher the window drives, so both start and stop the same poller. */
    watcher(): Watcher;

    /** Something an agent wrote is now on disk; the window is told to re-read it. */
    changed(change: WorkspaceChange): void;

    /**
     * The models the agents offer, which a new node starts on the first of when
     * Claude Code is not installed. Left out, new nodes start on Opus.
     */
    modelsOffered?(): Promise<OfferedModel[]>;
}

/** How far back the tools that offer a real email to run against look. */
const LOOKBACK_DAYS = 7;

/** A pass's events carry whole prompts and tool payloads; trimmed, not dropped. */
const MAX_DETAIL_CHARS = 4_000;

export const INSTRUCTIONS = `Patchbay wires email-processing flows on a canvas.

Everything here is in the workspace open in the app: a folder holding its flows
in flows/, the skills they share in skills/ and the schemas they share in
schemas/. Every step of every flow works in that folder. get_workspace says which
it is; only the person can open another.

A flow is a graph. Every node hands the email out of exactly one output port and
the engine follows the single edge attached to it, so a run is a readable path
rather than a fan-out. The nine node kinds:

- trigger.outlook — watches the mailbox folders it ticks and starts a run per
                    new email. \`folders\` holds each one's path under the
                    Inbox (list_folders' relativePath, "" for the Inbox
                    itself), read on its own and not the folders in it.
                    A folder made later is read only once it is listed.
                    \`monitor: true\` brings in the AI monitor for every
                    run it starts, which reviews the run once it ends.
- categorizer     — an if/else written in prose: each category is an output port
                    and its model picks exactly one, with an "unmatched" port
                    for the rest. It alone may run on Jev's models
                    (\`jev-latest\`), which answer with a probability per
                    category and no reason; no other node can.
- switch          — an if/else written as rules, with no model: each of
                    \`routes\` ({id, label}) is an output port, "route:<id>",
                    and \`rules\` are read top to bottom, each {field,
                    equals, route}: \`field\` is a slot and a path into it
                    ("quote.reply"), and the first rule whose field holds
                    \`equals\` sends the email down the route whose id is
                    its \`route\`. With none matching it leaves by
                    "otherwise". It does nothing to the email. With
                    \`output\` set, every port fills that slot with {route,
                    why}, route being the route's label or "Otherwise", so a
                    step where its routes meet again can read which. Pick it
                    over a categorizer when what decides is data an earlier
                    step already filled, not the email's wording.
- extractor       — pulls fields out of the email into the workspace schema
                    its \`schema\` names, and fills the slot named by
                    \`output\`. Ports: "valid", "invalid" and "error"; only
                    "valid" fills the slot. Like a processor it has the
                    workspace's skills, ticks the \`skills\` it loads first,
                    reads \`inputs\` and gets MCP server tools as a
                    processor does, but it cannot run commands.
- processor       — runs Claude or agy scoped to one email, with every skill in
                    the workspace and none from elsewhere. \`skills\` ticks,
                    by name, the ones it loads before anything else.
                    Ports: "done", "review" (it needs a person) and "error".
                    With \`output\` set and \`schema\` naming a workspace
                    schema, its result fills that slot on "done" — how one
                    step hands its work to the next.
                    It gets only the MCP server tools \`mcpTools\` names
                    and those its ticked skills grant: a skill's
                    frontmatter \`allowed-tools\` hands every node that
                    ticks it the \`mcp__<server>__<tool>\` entries there,
                    and nothing else it lists. list_server_tools gives a
                    server's tools. Its file tools
                    reach its run folder and the \`folders\` it ticks, as
                    [{folder, access}]: \`folder\` is a name from the
                    person's Settings → Folders (get_settings lists them)
                    and \`access\` "read" or "write", held to read where
                    Settings says so; a name Settings does not list stops
                    the run. \`allowShell\` gives it Bash, which no folder
                    holds. It drafts, sends and moves no mail: a
                    create-email, send or move-email after it does. One
                    from an older flow may still list "draft_reply" or
                    "move_email" in \`retiredTools\`; the run does not get
                    them, and the node is flagged until each is taken out,
                    once the node doing that is in place. One may also have
                    \`filesAnywhere\`, which still gives its run files
                    anywhere and is flagged until set to false.
- create-email    — drafts an email from a template email in the mailbox's
                    Templates folder, \`template\` being its subject and
                    \`section\` the [[SECTION]] it drafts ("" for a
                    template with none), and runs no model. \`account\`
                    is the Outlook account it drafts from, one
                    list_accounts gives: its Templates folder holds the
                    template, and a send sends from it. "" is the
                    account the email came to. \`mode\` is
                    "reply" (to the email; \`replyAll\` widens it) or "new"
                    (to \`to\`, copied to \`cc\`, with \`subject\`: each may
                    name fields in braces, "{{shipment.agent_email}}", that
                    the run writes in). \`placeholders\` ([{name, field}])
                    fill the template's {{NAME}}s from fields earlier nodes
                    filled; \`signature\` names an Outlook signature, one
                    list_signatures gives, or "" for none.
                    Whether an email gets one, and which, is the path's to
                    decide: put a switch before one create-email per email.
                    Ports: "drafted", "skipped" (already drafted by an
                    earlier run: a reply by any of the flow's create-email
                    nodes, a new email by this one) and "error"; the first
                    two fill \`output\` with {drafted, section, to,
                    account, draftEntryId, why}. It only drafts.
- send            — sends drafts a create-email made earlier in the same
                    run, picked by the draft slots its \`drafts\` lists,
                    each from the account it was drafted in, with no model. \`sending\` is false by default: while
                    off, and on every test run, it sends nothing and leaves
                    by "held", saying who each draft would have gone to, so
                    the drafts wait in Outlook for a person. A slot whose
                    create-email left by "skipped" holds no draft of this
                    run's and is passed over, so an earlier run's draft is
                    never sent by a later one, and each send is recorded so
                    the same draft is never sent twice. Ports: "sent",
                    "held" and "error"; every port fills \`output\` with
                    {sent, held, failed, why}, where \`sent\` and \`held\`
                    list recipients and \`failed\` is [{to, why}].
- move-email      — files the email into a folder in its mailbox, creating
                    the folder if it does not exist, with no model. \`folder\`
                    is a path under the Inbox ("Processed", "Clients\\Acme")
                    or a well-known folder ("Deleted Items"), and may name
                    fields in braces ("Processed/{{order.client}}") that the
                    run writes in. Ports: "moved" and "error". With \`output\`
                    set, both ports fill that slot with {moved, folder,
                    folderCreated, why}.
- terminal        — ends the path and records how the email came out, as
                    its \`disposition\`. It does nothing to the email: a
                    step that files it or saves its attachments does so
                    with its own tools.

A later node reads a slot by listing it in \`inputs\` (a processor or an
extractor) or in \`drafts\` (a send, where each slot must be a create-email's
draft), or by naming one of its fields: in a rule's \`field\` (a switch),
in a placeholder or in braces in To, Cc or Subject (a create-email), or in
braces in \`folder\` (a move-email);
get_flow's slotsOnArrival says which slots are sure to reach a node, and its
slotIssues flag a field the slot's schema lacks, a rule's value it never holds,
a slot in \`drafts\` that is not a draft, a switch's rule that leads to no
route it has, and a processor's \`retiredTools\`.

A categorizer, extractor or processor runs on its \`models\`: give it one,
[{model, effort, enabled: true}], from the models the person's agents offer.
With \`useFallbacks\` (true by default) a step whose model is at its usage limit
or out of reach goes on to the fallback models the person lists in Settings →
Agents (get_settings' \`fallbacks\`); false, it waits for its own model's limit
to lift. A node from before may list more models, which it tries first.

Every schema is the workspace's: schemas/<name>.json, made or replaced with
set_schema. A node never holds one of its own; its \`schema\` names one, as
{"$ref": "#/schemas/<name>"}, and a new extractor names none until you set it.
A field inside a schema can name another the same way, so a schema can be built
out of others. list_schemas gives them, and the nodes in each flow that use each
one; delete_schema is refused while any node or schema still names it.

Work in this order: list_flows, then get_flow to see the ports a node actually
has, then add_node / update_node / connect. Ports are derived from configuration
rather than stored, so editing a categorizer's categories or a switch's routes
moves its ports — an edge left hanging by that is dropped, and the tool result
says how many.

Before telling the person it works, run it: test_run puts one real email through
the flow, and get_run returns the trace, including why each node left by the port
it did. A run can wait in a queue before it starts; get_run says so, and why.

Having fixed a node a run went wrong at, continue_run runs the flow on from it
rather than from the trigger: the run is wound back to just before that node's
pass, the passes before it are carried over with the slots they filled, and the
node and everything after it run as the flow now is. Nothing before it runs
again — no model is asked twice, and no earlier step acts on the mailbox again.

A trace explains a run. When an email never became one — or a run never started —
get_console is where the app said why: polls, Outlook failures, mail marked seen.

A run started at a trigger with \`monitor\` on carries the AI monitor's review in
its \`monitor\`: once the run ends, a model with no tools reads the whole trace
against the flow and writes findings, each naming a node by id, what it saw in
the run and the change it suggests. It changes nothing. list_monitor_notes
gives the reviews across runs, newest first — the place to start when asked to
improve a flow from how it has been running. Weigh a suggestion against the
other runs before making it: each review saw one email.`;

// ── Results ──────────────────────────────────────────────────────────────

const text = (value: string) => ({content: [{type: 'text' as const, text: value}]});
const json = (value: unknown) => text(JSON.stringify(value, null, 2));

// ── Reading the workspace ────────────────────────────────────────────────

function requireFlow(flowId: string): Flow {
    const flow = flowStore.getFlow(flowId);
    if (!flow) throw new Error(`There is no flow "${flowId}". list_flows gives the ids this workspace holds.`);
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

const describeFlow = (flow: Flow) => {
    const {available, issues} = checkSlots(flow, schemaStore.workspaceSchemas());
    return {
        id: flow.id,
        name: flow.name,
        updatedAt: flow.updatedAt,
        nodes: flow.nodes.map((node) => ({
            ...describeNode(flow, node),
            // What a Processor or Extractor here may list in `inputs`. Absent when no trigger reaches it.
            slotsOnArrival: available.has(node.id) ? [...available.get(node.id)!.keys()] : undefined,
        })),
        edges: flow.edges,
        // Errors keep the flow from being watched; warnings do not.
        slotIssues: issues,
    };
};

/** The workspace's named schemas, each with the nodes in each flow that use it, directly or through another. */
function describeSchemas() {
    const schemas = schemaStore.workspaceSchemas();
    const flows = flowStore.listFlows();
    return schemaStore.listSchemas().map((entry) => ({
        ...entry,
        usedBy: flows.flatMap((flow) => {
            const nodes = schemaUsers(flow, schemas, entry.name).map((node) => node.id);
            return nodes.length > 0 ? [{flowId: flow.id, flowName: flow.name, nodes}] : [];
        }),
    }));
}

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
    const describePass = <P extends Pick<Pass, 'events'>>(pass: P) => ({
        ...pass,
        eventCount: pass.events.length,
        events: includeEvents
            ? pass.events.map((event) => ({
                ...event,
                detail: event.detail === undefined ? undefined : truncate(event.detail, MAX_DETAIL_CHARS),
            }))
            : [],
    });
    return {
        ...run,
        passes: run.passes.map(describePass),
        current: run.current && describePass(run.current),
        monitor: run.monitor && describePass(run.monitor),
    };
}

/** A run with an id and no trace yet: where it stands, and what it waits for. */
const describeQueued = (queued: QueuedRun) => ({
    id: queued.runId,
    flowId: queued.flowId,
    flowName: queued.flowName,
    status: 'queued' as const,
    trigger: queued.trigger,
    subject: queued.email.subject,
    senderEmail: queued.email.senderEmail,
    position: queued.position,
    waitingFor: queued.waitingFor,
});

// ── Writing the workspace ────────────────────────────────────────────────

/**
 * Apply an agent's edit, then repair it as an imported file would be: wrong-typed
 * values fall back to defaults, and edges left on a removed port are dropped. The
 * caller reports how many edges went.
 */
function editFlow(host: AgentHost, flowId: string, edit: (flow: Flow) => Flow) {
    const before = requireFlow(flowId);
    const edited = edit(before);
    const flow = flowStore.saveFlow(parseFlow(edited, before.id, before.name));
    host.changed({flows: true});
    return {flow, droppedEdges: edited.edges.length - flow.edges.length};
}

/** What a node's `schema` may hold: a reference to one of the workspace's, or nothing yet. */
const isNamedOrNone = (schema: unknown): boolean =>
    isObject(schema) && (Object.keys(schema).length === 0 || refName(schema) !== null);

/** A folder an agent named, with `~` expanded. Relative paths are refused: the agent can't know the app's cwd. */
function absoluteDir(dir: string): string {
    const path = dir === '~' || /^~[\\/]/.test(dir) ? join(homedir(), dir.slice(1)) : dir;
    if (!isAbsolute(path)) throw new Error(`"${dir}" is not an absolute path. Name the folder in full.`);
    return path;
}

// ── The surface ──────────────────────────────────────────────────────────

const flowIdArg = z.string().describe('Flow id, from list_flows.');

/** Registers every tool on a server. Called once per request, on a fresh one. */
export function registerAgentTools(server: McpServer, host: AgentHost): void {
    // ── The workspace ────────────────────────────────────────────────────

    server.registerTool(
        'get_workspace',
        {
            title: 'Get the workspace',
            description:
                'The workspace open in the app: its folder, which every step of every flow works in, the folders its flows, skills and schemas are kept in, and the README.md at the top of its folder if it has one — for a workspace that is a repository, the repository’s own, worth reading before changing its flows. There is no tool that opens another: switching closes the person’s canvases.',
            inputSchema: {},
            annotations: {readOnlyHint: true},
        },
        () => {
            const path = workspaceRoot();
            return json({
                name: basename(path),
                path,
                flows: flowsDirAt(),
                skills: skillsDirAt(),
                schemas: schemasDirAt(),
                readme: readmeFile(),
            });
        },
    );

    // ── Flows ────────────────────────────────────────────────────────────

    server.registerTool(
        'list_flows',
        {
            title: 'List flows',
            description:
                'Every flow in the workspace, with its id, its size, when it was last written and its file in the workspace’s flows folder.',
            inputSchema: {},
            annotations: {readOnlyHint: true},
        },
        () => {
            // Asked first, so with none open the agent hears that rather than of no flows.
            workspaceRoot();
            return json(
                flowStore.listFlowEntries().map(({flow, file}) => ({
                    id: flow.id,
                    name: flow.name,
                    updatedAt: flow.updatedAt,
                    nodeCount: flow.nodes.length,
                    edgeCount: flow.edges.length,
                    file,
                })),
            );
        },
    );

    server.registerTool(
        'get_flow',
        {
            title: 'Get a flow',
            description:
                'One flow in full: every node with its configuration, the output ports that configuration gives it, and what each port is wired to.',
            inputSchema: {flowId: flowIdArg},
            annotations: {readOnlyHint: true},
        },
        ({flowId}) => json(describeFlow(requireFlow(flowId))),
    );

    server.registerTool(
        'create_flow',
        {
            title: 'Create a flow',
            description:
                'Start an empty flow in the workspace, in a file of its own named after it. Nodes go on it with add_node.',
            inputSchema: {name: z.string().min(1)},
        },
        ({name}) => {
            const flow = flowStore.createFlow(name);
            host.changed({flows: true});
            return json(describeFlow(flow));
        },
    );

    server.registerTool(
        'rename_flow',
        {
            title: 'Rename a flow',
            description: 'Change what a flow is called. Its id, its graph and its file are untouched.',
            inputSchema: {flowId: flowIdArg, name: z.string().min(1)},
        },
        ({flowId, name}) => json(describeFlow(editFlow(host, flowId, (flow) => ({...flow, name})).flow)),
    );

    server.registerTool(
        'delete_flow',
        {
            title: 'Delete a flow',
            description:
                'Delete a flow’s file and the watcher marks that go with it. The skills it ticks stay: they are the workspace’s. Refused while a run of it is under way; runs of it still queued are cancelled. Nothing in the app undoes this, so ask the person first.',
            inputSchema: {flowId: flowIdArg},
            annotations: {destructiveHint: true, idempotentHint: true},
        },
        ({flowId}) => {
            const flow = requireFlow(flowId);
            const {file} = flowStore.entryFor(flow);
            const cancelled = host.watcher().clearForRemoval(flow.id);
            flowStore.removeFlow(flow.id);
            host.changed({flows: true});
            return text(
                `Deleted "${flow.name}", ${file}.` +
                (cancelled > 0 ? ` ${cancelled} queued run(s) of it were cancelled first.` : ''),
            );
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
        async ({flowId, kind, name, x, y}) => {
            const id = mintNodeId(requireFlow(flowId), kind);
            // An agent that cannot be asked leaves the node on Opus, for update_node to change.
            const offered = await host.modelsOffered?.().catch(() => null);
            const {flow} = editFlow(host, flowId, (current) => {
                // Placed to the right of everything already there, so a flow built
                // entirely through these tools still opens as something readable.
                const right = current.nodes.reduce((max, n) => Math.max(max, n.position.x), -180);
                const node = makeNode(kind, id, {x: x ?? right + 260, y: y ?? 200}, offered);
                return {...current, nodes: [...current.nodes, name ? {...node, name} : node]};
            });
            return json(describeNode(flow, requireNode(flow, id)));
        },
    );

    server.registerTool(
        'update_node',
        {
            title: 'Configure a node',
            description:
                'Change a node’s name, position or configuration. `config` is merged over what the node holds, so pass only the fields you are changing; a value of the wrong type falls back to that field’s default, and the result shows what actually stuck. Editing a categorizer’s categories or a switch’s routes moves its ports.',
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
        ({flowId, nodeId, name, x, y, config}) => {
            const schema = config?.schema;
            if (schema !== undefined && !isNamedOrNone(schema)) {
                throw new Error(
                    'A node never holds a schema of its own: its `schema` names one of the workspace’s, as {"$ref": "#/schemas/<name>"}. Make it with set_schema first.',
                );
            }
            const {flow, droppedEdges} = editFlow(host, flowId, (current) => {
                const node = requireNode(current, nodeId);
                const next: FlowNode = {
                    ...node,
                    name: name ?? node.name,
                    position: {x: x ?? node.position.x, y: y ?? node.position.y},
                    // Unvetted; `parseFlow` repairs it on the way out. `kind` goes
                    // last so a patch cannot change the node's kind.
                    config: {...node.config, ...config, kind: node.config.kind} as NodeConfig,
                };
                return {...current, nodes: current.nodes.map((n) => (n.id === nodeId ? next : n))};
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
            inputSchema: {flowId: flowIdArg, nodeId: z.string()},
            annotations: {destructiveHint: true, idempotentHint: true},
        },
        ({flowId, nodeId}) => {
            const {flow, droppedEdges} = editFlow(host, flowId, (current) => {
                requireNode(current, nodeId);
                return {...current, nodes: current.nodes.filter((n) => n.id !== nodeId)};
            });
            return json({flow: describeFlow(flow), droppedEdges});
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
                    .describe('Output port on the source node, e.g. "done", "out" or "cat:invoice".'),
                to: z.string().describe('Target node id.'),
            },
        },
        ({flowId, from, port, to}) => {
            const {flow} = editFlow(host, flowId, (current) => {
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
            inputSchema: {flowId: flowIdArg, edgeId: z.string()},
            annotations: {idempotentHint: true},
        },
        ({flowId, edgeId}) => {
            const {flow} = editFlow(host, flowId, (current) => ({
                ...current,
                edges: current.edges.filter((e) => e.id !== edgeId),
            }));
            return json(describeFlow(flow));
        },
    );

    // ── Named schemas ────────────────────────────────────────────────────

    const schemaNameArg = z
        .string()
        .regex(SLOT_NAME, 'Letters, digits and _ only, not starting with a digit.')
        .describe('Its file is schemas/<name>.json, and nodes refer to it as {"$ref": "#/schemas/<name>"}.');

    const schemasChanged = (flows: boolean): void => host.changed({flows, schemas: true});

    server.registerTool(
        'list_schemas',
        {
            title: 'List schemas',
            description:
                'The workspace’s named schemas, which every flow in it shares: each one’s file and JSON Schema, and the nodes in each flow that use it, directly or through another named schema. A file a node cannot use — not valid JSON, or a name a reference cannot spell — is listed with a `problem` and no schema.',
            inputSchema: {},
            annotations: {readOnlyHint: true},
        },
        () => {
            workspaceRoot();
            return json(describeSchemas());
        },
    );

    server.registerTool(
        'set_schema',
        {
            title: 'Name a schema',
            description:
                'Add a named schema to the workspace, as schemas/<name>.json, or replace the one of that name. Every node in every flow referring to it uses the new one at once. A field may refer to another named schema as {"$ref": "#/schemas/<name>"}.',
            inputSchema: {
                name: schemaNameArg,
                schema: z.record(z.string(), z.unknown()).describe('A JSON Schema object.'),
            },
        },
        ({name, schema}) => {
            schemaStore.saveSchema(name, schema);
            rewatch();
            schemasChanged(false);
            return json(describeSchemas().find((entry) => entry.name === name));
        },
    );

    server.registerTool(
        'rename_schema',
        {
            title: 'Rename a schema',
            description:
                'Rename one of the workspace’s named schemas, and its file. Every reference to it, in every flow’s nodes and in other schemas, follows.',
            inputSchema: {name: z.string(), to: schemaNameArg},
        },
        ({name, to}) => {
            flowStore.renameSchema(name, to);
            schemasChanged(true);
            return json(describeSchemas().find((entry) => entry.name === to));
        },
    );

    server.registerTool(
        'delete_schema',
        {
            title: 'Delete a schema',
            description:
                'Remove one of the workspace’s named schemas, and its file. Refused while a node in any flow, or another schema, still names it; the error says which. Point those at another schema first.',
            inputSchema: {name: z.string()},
            annotations: {destructiveHint: true, idempotentHint: true},
        },
        ({name}) => {
            if (!schemaStore.listSchemas().some((entry) => entry.name === name)) {
                return text(`The workspace has no schema "${name}", so nothing was deleted.`);
            }
            flowStore.removeSchema(name);
            schemasChanged(false);
            return text(`Deleted the schema "${name}".`);
        },
    );

    // ── Skills ───────────────────────────────────────────────────────────

    server.registerTool(
        'list_skills',
        {
            title: 'List skills',
            description:
                'The workspace’s library, which every flow in it shares. Every Processor and Extractor can use any of these and no other skill; a node’s `skills` ticks, by name, the ones it loads first. A skill’s `tools` are the MCP server tools its `allowed-tools` grant a node that ticks it; `ungranted` is the rest of that list, which it does not grant.',
            inputSchema: {},
            annotations: {readOnlyHint: true},
        },
        () => json(skillStore.listSkills()),
    );

    server.registerTool(
        'get_skill',
        {
            title: 'Read a skill',
            description: 'The whole SKILL.md, frontmatter included.',
            inputSchema: {name: z.string()},
            annotations: {readOnlyHint: true},
        },
        ({name}) => {
            const skill = skillStore.getSkill(name);
            if (!skill) throw new Error(`The workspace has no skill "${name}". list_skills gives the ones it has.`);
            return json(skill);
        },
    );

    server.registerTool(
        'write_skill',
        {
            title: 'Write a skill',
            description:
                'Create or replace a SKILL.md in the workspace’s library. Write the whole file: a `---` frontmatter block carrying `name` and `description`, then the instructions. The name has to be lowercase letters, digits and hyphens, because it becomes both a folder and a skill identifier. An `allowed-tools` line in the frontmatter (`allowed-tools: mcp__crm__lookup, mcp__crm__log`, or `mcp__<server>` for all of a server’s) hands those tools of the workspace’s MCP servers to every node that ticks the skill, so the tools a skill calls are named once, in it, rather than on each node; built-in tools listed there, such as Bash or Read, are not granted. Every flow in the workspace that ticks it gets the change.',
            inputSchema: {name: z.string(), content: z.string().min(1)},
        },
        ({name, content}) => {
            const summary = skillStore.saveSkill(name, content);
            rewatch();
            host.changed({skills: true});
            const front = skillStore.parseFrontmatter(content);
            return json({
                ...summary,
                warning:
                    front.name && front.description
                        ? undefined
                        : 'The frontmatter is missing a name or a description. An agent matches a skill on its description, so this one will be hard to reach.',
            });
        },
    );

    server.registerTool(
        'delete_skill',
        {
            title: 'Delete a skill',
            description:
                'Remove a skill folder from the workspace. Every node in every flow here that still ticks it then names a skill that is not there, and leaves by its error port when it runs.',
            inputSchema: {name: z.string()},
            annotations: {destructiveHint: true, idempotentHint: true},
        },
        ({name}) => {
            skillStore.removeSkill(name);
            host.changed({skills: true});
            const tickedBy = flowStore
                .listFlows()
                .filter((flow) =>
                    flow.nodes.some(
                        ({config}) =>
                            (config.kind === 'processor' || config.kind === 'extractor') && config.skills.includes(name),
                    ),
                )
                .map((flow) => flow.name);
            return text(
                `Deleted the skill "${name}".` +
                (tickedBy.length > 0 ? ` Still ticked in: ${tickedBy.join(', ')}. Untick it there, or put it back.` : ''),
            );
        },
    );

    server.registerTool(
        'import_skills',
        {
            title: 'Import skills from a folder',
            description:
                'Copy skills from a folder on this machine into the workspace’s library, each skill folder whole — its SKILL.md and whatever sits beside it, scripts and references included. What write_skill cannot carry. A skill of the same name already in the library is replaced; the result names those.',
            inputSchema: {
                dir: z
                    .string()
                    .describe(
                        'Absolute path to a folder whose subfolders each hold a SKILL.md — ~/.claude/skills or ~/.gemini/config/skills, say.',
                    ),
                names: z
                    .array(z.string())
                    .optional()
                    .describe('Only these skills from the folder. Default: every one it holds.'),
            },
        },
        ({dir, names}) => {
            const from = absoluteDir(dir);
            if (existsSync(join(from, 'SKILL.md'))) {
                throw new Error(
                    `"${dir}" is a skill itself. Pass the folder it sits in as dir, and "${basename(from)}" in names.`,
                );
            }
            const before = new Set(skillStore.listSkills().map((s) => s.name));
            const imported = skillStore.importSkillsFrom(from, names);
            rewatch();
            host.changed({skills: true});
            const missing = names?.filter((name) => !imported.includes(name)) ?? [];
            return json({
                imported,
                replaced: imported.filter((name) => before.has(name)),
                notFound: missing.length > 0 ? missing : undefined,
                note:
                    missing.length > 0
                        ? 'A name is imported only when the folder has a subfolder of that name holding a SKILL.md, and the name is lowercase letters, digits and hyphens.'
                        : undefined,
            });
        },
    );

    // ── The mailbox, as far as choosing an email ─────────────────────────

    server.registerTool(
        'list_accounts',
        {
            title: 'List Outlook accounts',
            description: 'The accounts the desktop Outlook client on this machine is signed in to.',
            inputSchema: {},
            annotations: {readOnlyHint: true},
        },
        async () => json(await outlook.getAccounts()),
    );

    server.registerTool(
        'list_signatures',
        {
            title: 'List Outlook signatures',
            description:
                'The signatures the desktop Outlook client on this machine keeps, by name: what a create-email’s `signature` names. Outlook keeps one set for all its accounts, so any of them can sign mail from any account.',
            inputSchema: {},
            annotations: {readOnlyHint: true},
        },
        async () => json(await outlook.getSignatures()),
    );

    server.registerTool(
        'list_folders',
        {
            title: 'List mailbox folders',
            description:
                'The Inbox and every folder below it, for one account. `relativePath` is what a trigger lists in its `folders`, and the Inbox itself is the empty string.',
            inputSchema: {account: z.string()},
            annotations: {readOnlyHint: true},
        },
        async ({account}) => json(await outlook.listFolders(account)),
    );

    server.registerTool(
        'list_recent_emails',
        {
            title: 'List recent emails',
            description:
                'Recent mail in some folders — subject, sender and a short preview — so a real message can be picked for test_run. Nothing here fetches a body out of Outlook: that is for the scoped tools of the run that handles it.',
            inputSchema: {
                account: z.string(),
                folders: z
                    .array(z.string())
                    .optional()
                    .describe(
                        'Paths relative to the Inbox, each read on its own; "" is the Inbox. Default: the Inbox. No previews when more than one folder is read.',
                    ),
                limit: z.number().int().min(1).max(50).optional(),
            },
            annotations: {readOnlyHint: true},
        },
        async ({account, folders, limit}) => {
            const emails = await outlook.readScope({account, folders: folders ?? ['']}, LOOKBACK_DAYS, limit ?? 20);
            return json(emails.map(describeEmail));
        },
    );

    // ── Running ──────────────────────────────────────────────────────────

    server.registerTool(
        'get_status',
        {
            title: 'Engine status',
            description:
                'Which flows are switched on, which of their triggers are polled, when it last polled and what is running now.',
            inputSchema: {},
            annotations: {readOnlyHint: true},
        },
        () => json(host.watcher().status()),
    );

    server.registerTool(
        'start_watching',
        {
            title: 'Start watching a flow',
            description:
                'Switch one flow on. Every trigger in it that names a mailbox starts polling it, and mail that arrives starts real runs that cost real money. Refused while polling is off in Settings, and for a flow with no trigger that names a mailbox.',
            inputSchema: {flowId: flowIdArg},
        },
        ({flowId}) => json(host.watcher().start(requireFlow(flowId).id)),
    );

    server.registerTool(
        'stop_watching',
        {
            title: 'Stop watching a flow',
            description: 'Switch one flow off. A run of it already under way is left to finish.',
            inputSchema: {flowId: flowIdArg},
            annotations: {idempotentHint: true},
        },
        ({flowId}) => json(host.watcher().stop(flowId)),
    );

    server.registerTool(
        'test_run',
        {
            title: 'Test a flow against one email',
            description:
                'Put one real email through a flow now, ignoring the watermark, starting at the trigger named. Without an entryId the newest message in that trigger’s folder is used. This runs the flow’s models and costs money, and acts on the real mailbox: a create-email leaves a draft and a move-email files the email. A send never sends on a test run. Returns the run id; get_run has the trace.',
            inputSchema: {
                flowId: flowIdArg,
                nodeId: z.string().describe('The trigger to start from — a flow may have several.'),
                entryId: z.string().optional().describe('From list_recent_emails.'),
            },
        },
        async ({flowId, nodeId, entryId}) => {
            const flow = requireFlow(flowId);
            const node = flow.nodes.find((n) => n.id === nodeId);
            const config = triggerConfig(node);
            if (!node || !config) {
                throw new Error(`"${nodeId}" is not a trigger in "${flow.name}", and a run starts at a trigger.`);
            }
            if (!config.account.trim()) {
                throw new Error(`"${node.name}" names no mailbox yet. Give it an account with update_node first.`);
            }
            const recent = await outlook.readScope(config, LOOKBACK_DAYS, 50);
            const email = entryId ? recent.find((e) => e.ref.entryId === entryId) : recent[0];
            if (!email) {
                throw new Error(
                    entryId
                        ? `No email with entryId "${entryId}" in the last ${LOOKBACK_DAYS} days of that folder.`
                        : `Nothing in the last ${LOOKBACK_DAYS} days of that folder to test against.`,
                );
            }
            const runId = host.watcher().enqueueManual(flow.id, node.id, email);
            return json({
                runId,
                email: describeEmail(email),
                note: 'Queued. Poll get_run: it says "queued" and why until the run starts, then has the trace.',
            });
        },
    );

    server.registerTool(
        'continue_run',
        {
            title: 'Continue a run from one of its nodes',
            description:
                'Wind a finished run back to just before one of its passes, and run the flow on from that pass’s node as a new run. The passes before it are carried over as they ran, with the slots they filled, and the files the run saved come along; that node and everything after it run as the flow now is, so a node fixed since runs fixed. Nothing before it runs again. Name the pass by `seq` (get_run numbers them), or by `nodeId` when the run visited that node once. Like test_run it costs money and acts on the real mailbox from that node on, and a send never sends. The earlier run is left as it was. Returns the new run’s id; get_run has the trace, with the carried passes marked `carried`.',
            inputSchema: {
                runId: z.string().describe('A finished run, from list_runs.'),
                seq: z.number().int().min(1).optional().describe('The pass to continue from: it runs again, and so does all that follows.'),
                nodeId: z.string().optional().describe('Instead of seq: the node to continue from, when the run visited it once.'),
            },
        },
        async ({runId, seq, nodeId}) => {
            const run = traceStore.getRun(runId);
            if (!run) throw new Error(`There is no run "${runId}". list_runs gives the ids.`);
            let at = seq;
            if (nodeId !== undefined) {
                const visits = run.passes.filter((pass) => pass.nodeId === nodeId);
                const [visit] = visits;
                if (!visit) throw new Error(`Run ${runId} never reached node "${nodeId}". get_run gives the path it took.`);
                if (at === undefined && visits.length > 1) {
                    throw new Error(
                        `Run ${runId} visited ${visit.nodeName} ${visits.length} times, as passes ${visits.map((p) => p.seq).join(', ')}. Say which with seq.`,
                    );
                }
                if (at !== undefined && !visits.some((pass) => pass.seq === at)) {
                    throw new Error(`Pass ${at} of run ${runId} is not at node "${nodeId}"; its passes there are ${visits.map((p) => p.seq).join(', ')}.`);
                }
                at ??= visit.seq;
            }
            if (at === undefined) throw new Error('Say which pass to continue from: seq, or nodeId.');
            const {runId: next, rewound} = await host.watcher().continueRun(runId, at);
            return json({
                runId: next,
                continuesFrom: {runId, seq: at, node: rewound.nodeName},
                carried: rewound.passes.map((pass) => `${pass.seq} ${pass.nodeName}`),
                slots: Object.keys(rewound.data),
                note: 'Queued. Poll get_run: it says "queued" and why until the run starts, then has the trace.',
            });
        },
    );

    server.registerTool(
        'cancel_run',
        {
            title: 'Cancel a run',
            description:
                'Abort a run under way, keeping its trace up to that point — or take one out of the queue before it starts, which leaves no trace at all. Given a run that has ended and is being reviewed by the AI monitor, it stops the review.',
            inputSchema: {runId: z.string()},
            annotations: {idempotentHint: true},
        },
        ({runId}) => {
            const waiting = host.watcher().queued().find((q) => q.runId === runId);
            switch (host.watcher().cancel(runId)) {
                case 'stopping':
                    return text(`Asked run ${runId} to stop. The trace up to that point is kept; get_run has it.`);
                case 'review-stopped':
                    return text(
                        `Run ${runId} had already ended. The AI monitor's review of it is stopped, and get_run shows it as skipped.`,
                    );
                case 'dequeued':
                    return text(
                        `Run ${runId} had not started, and is out of the queue. It will not run and leaves no trace.` +
                        (waiting?.trigger === 'poll'
                            ? ' Its email was marked seen when it was polled, so no later poll will pick it up; test_run can still put it through.'
                            : ''),
                    );
                case 'unknown':
                    return text(
                        `Nothing to cancel: run ${runId} is neither under way nor queued. If it existed it has finished, and get_run shows how.`,
                    );
            }
        },
    );

    server.registerTool(
        'list_runs',
        {
            title: 'List runs',
            description:
                'Recent runs, newest first: what each handled and how it ended. Runs still queued or under way come first, whatever the limit — those are the ones an agent is usually waiting on.',
            inputSchema: {
                limit: z.number().int().min(1).max(200).optional().describe('Finished runs to include. Default 20.'),
                flowId: z.string().optional().describe('Only runs of this flow.'),
            },
            annotations: {readOnlyHint: true},
        },
        ({limit, flowId}) => {
            const wanted = limit ?? 20;
            const mine = (run: { flowId: string }): boolean => !flowId || run.flowId === flowId;
            // Filtered after the walk, so a flow that has not run lately still costs
            // one bounded read of the index rather than the whole of it.
            const finished = traceStore.listRuns(flowId ? 500 : wanted).filter(mine).slice(0, wanted);
            // Runs still going aren't in the index yet, so they come from the watcher.
            const indexed = new Set(finished.map((run) => run.id));
            const watcher = host.watcher();
            const running = watcher
                .status()
                .activeRunIds.filter((id) => !indexed.has(id))
                .flatMap((id) => {
                    const run = traceStore.getRun(id);
                    return run && mine(run) ? [toSummary(run)] : [];
                })
                .toReversed();
            const queued = watcher.queued().filter(mine).map(describeQueued).toReversed();
            return json([...queued, ...running, ...finished]);
        },
    );

    server.registerTool(
        'get_run',
        {
            title: 'Read a run',
            description:
                'One run in full: the path it took and, per node, the port it left by, the one-line reason, and every prompt and tool call. This is where you find out why an email went where it did — and, since a prompt carries the email it was about, where a handled message can be read back. A run under way has `current`: the node it is at now and what it has done there so far.',
            inputSchema: {
                runId: z.string(),
                includeEvents: z
                    .boolean()
                    .optional()
                    .describe('Default true. False keeps the passes and their outcomes but drops the detail.'),
            },
            annotations: {readOnlyHint: true},
        },
        ({runId, includeEvents}) => {
            const run = traceStore.getRun(runId);
            if (run) return json(describeRun(run, includeEvents !== false));
            // A queued run has an id before it has a file.
            const queued = host.watcher().queued().find((q) => q.runId === runId);
            if (!queued) throw new Error(`There is no run "${runId}".`);
            return json({
                ...describeQueued(queued),
                note: 'Not started yet, so there is no trace. Ask again once it has; cancel_run takes it out of the queue.',
            });
        },
    );

    server.registerTool(
        'list_monitor_notes',
        {
            title: 'List the AI monitor’s reviews',
            description:
                'What the AI monitor found in the runs it reviewed, newest first: per run, a verdict (fine, suggestions or problem), a summary, and findings that each name a node by id, what happened in that run, and the change it suggests to the flow, a skill or a schema. Only runs started at a trigger with `monitor` on are reviewed. A review saw one email: a suggestion several reviews make is worth more than one made once. get_run has a review in full, with the prompt the monitor was sent.',
            inputSchema: {
                flowId: z.string().optional().describe('Only reviews of this flow’s runs.'),
                limit: z.number().int().min(1).max(200).optional().describe('Default 20.'),
                findingsOnly: z
                    .boolean()
                    .optional()
                    .describe('Default false. True leaves out reviews that found nothing to change.'),
            },
            annotations: {readOnlyHint: true},
        },
        ({flowId, limit, findingsOnly}) => {
            const wanted = limit ?? 20;
            const notes = traceStore
                .listReviews(findingsOnly ? 1_000 : wanted, flowId)
                .filter((note) => !findingsOnly || note.findings.length > 0)
                .slice(0, wanted);
            return json(notes);
        },
    );

    // ── The console ──────────────────────────────────────────────────────

    server.registerTool(
        'get_console',
        {
            title: 'Read the console',
            description:
                'What the app did outside any one run: each poll and what it found, the first poll that marks a folder’s mail seen without running it, queued mail dropped or cancelled, Outlook calls and their failures, runs starting and ending, and every agent tool call. The place to look when an email never became a run. Returns the newest `limit` entries that pass the filters, oldest first. Without `day` it reads what this session holds — the last 2,000 lines, emptied by the window’s Clear; with one it reads that day’s file, which survives a restart and is kept 14 days.',
            inputSchema: {
                level: z
                    .enum(LOG_LEVELS)
                    .optional()
                    .describe(
                        'The quietest level included. Default "info"; "debug" adds routine lines, such as a poll that found nothing or an Outlook call that worked.',
                    ),
                source: z.enum(LOG_SOURCES).optional().describe('Only lines from this part of the app.'),
                runId: z.string().optional().describe('Only lines about this run.'),
                afterSeq: z
                    .number()
                    .int()
                    .optional()
                    .describe(
                        'Only lines after this seq: pass the last seq you saw to read what is new. Without `day` only, since seq starts again when the app does.',
                    ),
                day: z.string().optional().describe('YYYY-MM-DD, local time.'),
                limit: z.number().int().min(1).max(500).optional().describe('Default 100.'),
            },
            annotations: {readOnlyHint: true},
        },
        ({level, source, runId, afterSeq, day, limit}) => {
            const floor = LOG_LEVELS.indexOf(level ?? 'info');
            const matching = (day ? logEntriesOn(day) : logEntries()).filter(
                (entry) =>
                    LOG_LEVELS.indexOf(entry.level) >= floor &&
                    (!source || entry.source === source) &&
                    (!runId || entry.runId === runId) &&
                    (afterSeq === undefined || entry.seq > afterSeq),
            );
            const shown = matching.slice(-(limit ?? 100));
            return json({
                entries: shown.map((entry) =>
                    entry.detail === undefined ? entry : {...entry, detail: truncate(entry.detail, MAX_DETAIL_CHARS)},
                ),
                olderNotShown: matching.length - shown.length,
            });
        },
    );

    // ── Settings, read only ──────────────────────────────────────────────

    server.registerTool(
        'get_settings',
        {
            title: 'Read settings',
            description:
                'App settings and the MCP servers found in the open workspace, with the agent-control token withheld and each server’s env and headers named but not given. A run is handed only the workspace’s servers. `folders` are the only folders a Processor’s file tools can be handed: a node ticks one by its `name`. `fallbacks` are the models every Categorizer, Extractor and Processor whose `useFallbacks` is on goes on to, in turn, when its own are at their usage limit or out of reach. There is no tool that writes these or allows a workspace server: the executables, MCP servers and folders handed to a Processor decide what code a run can execute and what it can reach, so they stay with the person at the window.',
            inputSchema: {},
            annotations: {readOnlyHint: true},
        },
        () => {
            const settings = getSettings();
            const {servers, unreadable} = listMcpServers();
            return json({
                appVersion: app.getVersion(),
                ...settings,
                workspaceMcpServers: servers,
                ...(unreadable.length > 0 ? {unreadableMcpFiles: unreadable} : {}),
                agentControl: {...settings.agentControl, token: '(withheld)'},
            });
        },
    );

    server.registerTool(
        'list_server_tools',
        {
            title: 'List an MCP server’s tools',
            description:
                'The tools one of the MCP servers allowed in the workspace offers, asked of the server itself. A processor or extractor is handed only the tools its `mcpTools` names and its ticked skills’ `allowed-tools` grant — `mcp__<server>__<tool>` for one, `mcp__<server>` for all of a server’s — so this is how to name the few a step needs.',
            inputSchema: {server: z.string().describe('The server’s name, as get_settings lists it.')},
            annotations: {readOnlyHint: true},
        },
        async ({server: name}) => {
            const tools = await listServerTools(name);
            return json(tools.map((t) => ({ref: `mcp__${name}__${t.name}`, description: t.description})));
        },
    );
}
