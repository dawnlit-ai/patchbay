import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Background,
    BackgroundVariant,
    BaseEdge,
    type Connection,
    Controls,
    type Edge,
    type EdgeChange,
    type EdgeProps,
    getBezierPath,
    Handle,
    MiniMap,
    type Node,
    type NodeChange,
    type NodeProps,
    Position,
    ReactFlow,
} from '@xyflow/react';
import {
    type Available,
    connectNodes,
    type Flow,
    type FlowIssue,
    type FlowNode,
    folderLabel,
    hasInput,
    makeNode,
    mintNodeId,
    modelsInTurn,
    NODE_KIND_META,
    type NodeKind,
    type OfferedModel,
    outputPorts,
    provides,
    requires,
    type SlotCheck,
    slotTypeLabel,
} from '@shared/flow';
import type { Pass, PassUnderWay } from '@shared/trace';
import type { OutlookDrag } from '@shared/ipc';
import { activity } from '../activity';
import { type DataTokens, tint } from '../slotColors';
import { ContextMenu } from './ContextMenu';
import { Elapsed } from './Elapsed';

/**
 * The canvas. The Flow is the only source of truth: React Flow's nodes are derived
 * from it every render, and every interaction becomes a Flow edit.
 */

export interface CanvasHighlight {
    /** Pass by node id, for the run currently being inspected. */
    passes: Map<string, Pass>;
    takenEdges: Set<string>;
    /** The pass the run is in the middle of, while it is under way. */
    current?: PassUnderWay;
}

interface NodeData extends Record<string, unknown> {
    flowNode: FlowNode;
    pass?: Pass;
    /** Set on the node the run is at now. A node visited before keeps its `pass` too. */
    working?: PassUnderWay;
    /**
     * While an email is being dragged: `ready` on every trigger it could start a
     * run at, `over` on the one it would land on if let go now.
     */
    drop?: 'ready' | 'over';
    /** What `checkSlots` found wrong with the slots this node reads or fills. */
    issues: FlowIssue[];
    /** The slots every path here fills. Undefined when no trigger reaches the node. */
    available?: Available;
    tokens: DataTokens;
}

interface EdgeData extends Record<string, unknown> {
    onRemove(edgeId: string): void;
}

function NodeCard({ data, selected }: NodeProps): JSX.Element {
    const { flowNode, pass, working, drop, issues, available, tokens } = data as NodeData;
    const reads = requires(flowNode);
    const meta = NODE_KIND_META[flowNode.kind];
    const ports = outputPorts(flowNode);

    const classes = ['node', `kind-${meta.token}`];
    if (selected) classes.push('selected');
    if (working) classes.push('working');
    else if (pass) classes.push(pass.status === 'error' ? 'failed' : 'visited');
    if (drop) classes.push(`drop-${drop}`);

    return (
        <div className={classes.join(' ')}>
            {hasInput(flowNode.kind) && <Handle type="target" position={Position.Left} id="in"/>}

            <div className="node-head">
                <span className="dot"/>
                <span className="kind">{meta.label}</span>
                {working ? (
                    <span className="seq">
                        #{working.seq} · <Elapsed from={working.startedAt}/>
                    </span>
                ) : (
                    pass && <span className="seq">#{pass.seq}</span>
                )}
            </div>

            <div className="node-title">{flowNode.name}</div>
            <div className="node-sub">{describe(flowNode)}</div>

            {reads.length > 0 && (
                <div className="node-io">
                    <span className="io-label">reads</span>
                    {reads.map((name) => {
                        const type = available?.get(name);
                        // Unknown until a trigger reaches the node; missing once one does.
                        const missing = available !== undefined && !type;
                        return (
                            <span
                                key={name}
                                className={classNames('slot-chip', missing ? 'missing' : tint(tokens.get(name)))}
                                title={type ? slotTypeLabel(type) : missing ? 'Not filled on every path here' : undefined}
                            >
                                {name}
                            </span>
                        );
                    })}
                </div>
            )}

            {ports.length > 0 && (
                <div className="node-ports">
                    {ports.map((port) => (
                        <div
                            key={port.id}
                            className={`node-port ${port.tone}${pass?.outPort === port.id ? ' taken' : ''}`}
                        >
                            {port.label}
                            {provides(flowNode, port.id).map((slot) => (
                                <span
                                    key={slot.name}
                                    className={classNames('slot-chip adds', tint(tokens.get(slot.name)))}
                                    title={slotTypeLabel(slot.type)}
                                >
                                    + {slot.name}
                                </span>
                            ))}
                            <Handle
                                type="source"
                                position={Position.Right}
                                id={port.id}
                                className={classNames(
                                    tint(wireToken(flowNode, port.id, available, tokens)),
                                    pass?.outPort === port.id && 'taken-handle',
                                )}
                            />
                        </div>
                    ))}
                </div>
            )}

            {issues.map((issue) => (
                <div key={issue.message} className={`node-issue ${issue.severity}`}>
                    {issue.message}
                </div>
            ))}

            {working ? (
                <div className="node-note working">{activity(working)}</div>
            ) : (
                pass && <div className="node-note">{pass.summary}</div>
            )}
        </div>
    );
}

/** The one-line subtitle on a node card: its configuration at a glance. */
function describe(node: FlowNode): string {
    const c = node.config;
    switch (c.kind) {
        case 'trigger.outlook':
            return c.account
                ? `${c.account} \\ ${folderLabel(c)} · every ${c.pollSeconds}s`
                : 'No mailbox selected yet';
        case 'categorizer':
            return `${c.categories.length} categor${c.categories.length === 1 ? 'y' : 'ies'} · ${modelsInTurn(c.models)[0]?.model ?? 'no model on'}`;
        case 'extractor': {
            const fields = Object.keys((c.schema.properties as Record<string, unknown> | undefined) ?? {}).length;
            return `→ ${c.output} · ${fields} field${fields === 1 ? '' : 's'}${c.includeAttachments ? ' · reads attachments' : ''}`;
        }
        case 'processor':
            return c.skills.length > 0
                ? `skills: ${c.skills.join(', ')}`
                : 'No skill assigned — instruction only';
        case 'terminal':
            return c.disposition;
    }
}

/**
 * The colour token of what leaves `node` by `port`: the slot the port adds, or
 * else the newest one the node holds — what the step before handed on. Undefined
 * while no trigger reaches the node, when what it holds is not known.
 */
function wireToken(
    node: FlowNode,
    port: string,
    available: Available | undefined,
    tokens: DataTokens,
): string | undefined {
    const newest = provides(node, port).at(-1)?.name ?? (available && [...available.keys()].at(-1));
    return newest === undefined ? undefined : tokens.get(newest);
}

const classNames = (...names: (string | false | null | undefined)[]): string | undefined =>
    names.filter(Boolean).join(' ') || undefined;

/**
 * An edge with its cut button, drawn inside the edge's own group (not via
 * EdgeLabelRenderer) so one CSS hover rule covers both wire and button.
 */
function Wire({
                  id,
                  sourceX,
                  sourceY,
                  sourcePosition,
                  targetX,
                  targetY,
                  targetPosition,
                  markerEnd,
                  style,
                  interactionWidth,
                  data,
              }: EdgeProps): JSX.Element {
    const [path, midX, midY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
    });
    const { onRemove } = data as EdgeData;

    return (
        <>
            <BaseEdge
                id={id}
                path={path}
                markerEnd={markerEnd}
                style={style}
                interactionWidth={interactionWidth}
            />
            <g
                className="edge-cut"
                transform={`translate(${midX} ${midY})`}
                // The click would otherwise land on the edge behind it and only select it.
                onClick={(e) => {
                    e.stopPropagation();
                    onRemove(id);
                }}
            >
                <title>Remove this connection</title>
                <circle r={9}/>
                <path d="M -3.4 -3.4 L 3.4 3.4 M 3.4 -3.4 L -3.4 3.4"/>
            </g>
        </>
    );
}

const nodeTypes = { card: NodeCard };
const edgeTypes = { wire: Wire };

/**
 * React Flow takes plain colour strings rather than CSS variables, so read the
 * token off the document. Called during render, after the theme attribute is
 * set, so these follow a theme switch.
 */
function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface FlowCanvasProps {
    flow: Flow;
    selectedNodeId: string | null;
    highlight: CanvasHighlight | null;
    slots: SlotCheck | null;
    /** Each slot's colour, which its wires, handles and chips take. */
    tokens: DataTokens;

    onChange(flow: Flow): void;

    onSelect(nodeId: string | null): void;

    /** Something dragged in from outside the app — an email out of Outlook — was dropped on a trigger. */
    onRunOutlookDrag(nodeId: string, drag: OutlookDrag): void;

    /** A trigger was asked to run the email selected in Outlook — the Mac's stand-in for a drag. */
    onRunOutlookSelected(nodeId: string): void;
}

/** What the node palette puts on a drag: the kind of node to place. */
export const NODE_DRAG_TYPE = 'application/flow-node';

export function FlowCanvas({
                               flow,
                               selectedNodeId,
                               highlight,
                               slots,
                               tokens,
                               onChange,
                               onSelect,
                               onRunOutlookDrag,
                               onRunOutlookSelected,
                           }: FlowCanvasProps): JSX.Element {
    const wrapper = useRef<HTMLDivElement>(null);
    /**
     * The models the agents offer, which a dropped node starts on the first of when
     * Claude Code is not installed. Null until they answer, when it starts on Opus.
     */
    const offered = useRef<OfferedModel[] | null>(null);
    useEffect(() => {
        void window.api.agents
            .models()
            .then((list) => (offered.current = list))
            .catch(() => undefined);
    }, []);
    /** The trigger a dragged email is over. Only read while `mailDrag` holds. */
    const [dropTarget, setDropTarget] = useState<string | null>(null);
    /** Something from outside the app is being dragged over the canvas — an email out of Outlook, most likely. */
    const [mailDrag, setMailDrag] = useState(false);
    /** The trigger right-clicked, and where. */
    const [menu, setMenu] = useState<{ node: FlowNode; x: number; y: number } | null>(null);
    /**
     * Each card's last measured size, handed back on every rebuilt node. React Flow
     * hides a node without one, which blanked the canvas on every frame of a drag,
     * and the minimap leaves it out. State, so a new size rebuilds the nodes.
     */
    const [measured, setMeasured] = useState<ReadonlyMap<string, { width: number; height: number }>>(
        () => new Map(),
    );

    const rfNodes: Node[] = useMemo(
        () =>
            flow.nodes.map((n) => {
                let drop: NodeData['drop'];
                if (mailDrag && n.kind === 'trigger.outlook') drop = n.id === dropTarget ? 'over' : 'ready';
                return {
                    id: n.id,
                    type: 'card',
                    position: n.position,
                    measured: measured.get(n.id),
                    selected: n.id === selectedNodeId,
                    data: {
                        flowNode: n,
                        pass: highlight?.passes.get(n.id),
                        working: highlight?.current?.nodeId === n.id ? highlight.current : undefined,
                        drop,
                        issues: slots?.issues.filter((issue) => issue.nodeId === n.id) ?? [],
                        available: slots?.available.get(n.id),
                        tokens,
                    } satisfies NodeData,
                };
            }),
        [flow.nodes, measured, selectedNodeId, highlight, mailDrag, dropTarget, slots, tokens],
    );

    const removeEdge = useCallback(
        (edgeId: string) => onChange({ ...flow, edges: flow.edges.filter((e) => e.id !== edgeId) }),
        [flow, onChange],
    );

    const rfEdges: Edge[] = useMemo(() => {
        const byId = new Map(flow.nodes.map((n) => [n.id, n]));
        return flow.edges.map((e) => {
            const source = byId.get(e.source);
            return {
                id: e.id,
                type: 'wire',
                source: e.source,
                sourceHandle: e.sourceHandle,
                target: e.target,
                targetHandle: 'in',
                className: classNames(
                    source && tint(wireToken(source, e.sourceHandle, slots?.available.get(e.source), tokens)),
                    highlight && (highlight.takenEdges.has(e.id) ? 'taken' : 'untaken'),
                ),
                data: { onRemove: removeEdge } satisfies EdgeData,
            };
        });
    }, [flow.nodes, flow.edges, highlight, removeEdge, slots, tokens]);

    const onNodesChange = useCallback(
        (changes: NodeChange[]) => {
            let nodes = flow.nodes;
            let edges = flow.edges;
            let touched = false;
            const sized = new Map<string, { width: number; height: number }>();

            for (const change of changes) {
                if (change.type === 'dimensions' && change.dimensions) {
                    sized.set(change.id, change.dimensions);
                } else if (change.type === 'position' && change.position) {
                    const { position } = change;
                    nodes = nodes.map((n) => (n.id === change.id ? { ...n, position } : n));
                    touched = true;
                } else if (change.type === 'remove') {
                    nodes = nodes.filter((n) => n.id !== change.id);
                    edges = edges.filter((e) => e.source !== change.id && e.target !== change.id);
                    touched = true;
                    if (selectedNodeId === change.id) onSelect(null);
                }
            }
            if (sized.size > 0) {
                // Unchanged sizes keep the same map, so a re-report rebuilds nothing.
                setMeasured((prev) =>
                    [...sized].every(([id, size]) => prev.get(id)?.width === size.width && prev.get(id)?.height === size.height)
                        ? prev
                        : new Map([...prev, ...sized]),
                );
            }
            if (touched) onChange({ ...flow, nodes, edges });
        },
        [flow, onChange, onSelect, selectedNodeId],
    );

    const onEdgesChange = useCallback(
        (changes: EdgeChange[]) => {
            const removed = new Set(
                changes.filter((c): c is EdgeChange & { id: string } => c.type === 'remove').map((c) => c.id),
            );
            if (removed.size === 0) return;
            onChange({ ...flow, edges: flow.edges.filter((e) => !removed.has(e.id)) });
        },
        [flow, onChange],
    );

    const onConnect = useCallback(
        (connection: Connection) => {
            if (!connection.source || !connection.target || !connection.sourceHandle) return;
            if (connection.source === connection.target) return;
            onChange(connectNodes(flow, connection.source, connection.sourceHandle, connection.target));
        },
        [flow, onChange],
    );

    /** The trigger under a drag, found by element rather than coordinates to avoid pan/zoom maths. */
    const triggerAt = useCallback(
        (target: EventTarget): string | null => {
            const id =
                target instanceof Element ? target.closest('.react-flow__node')?.getAttribute('data-id') : null;
            return id && flow.nodes.some((n) => n.id === id && n.kind === 'trigger.outlook') ? id : null;
        },
        [flow.nodes],
    );

    const onDragOver = useCallback(
        (event: React.DragEvent) => {
            event.preventDefault();
            const { types } = event.dataTransfer;
            if (types.includes(NODE_DRAG_TYPE)) {
                event.dataTransfer.dropEffect = 'move';
                return;
            }
            // From outside the app, e.g. an Outlook email. Only a trigger accepts it.
            // Never 'move': Outlook would take the email out of the mailbox.
            setMailDrag(true);
            const id = triggerAt(event.target);
            setDropTarget(id);
            event.dataTransfer.dropEffect = id ? 'copy' : 'none';
        },
        [triggerAt],
    );

    const onDrop = useCallback(
        (event: React.DragEvent) => {
            event.preventDefault();
            const { dataTransfer } = event;
            if (!dataTransfer.types.includes(NODE_DRAG_TYPE)) {
                setDropTarget(null);
                setMailDrag(false);
                const id = triggerAt(event.target);
                if (!id) return;
                onRunOutlookDrag(id, {
                    text: dataTransfer.getData('text/plain'),
                    fileNames: [...dataTransfer.files].map((file) => file.name),
                    types: [...dataTransfer.types],
                });
                return;
            }
            const kind = dataTransfer.getData(NODE_DRAG_TYPE) as NodeKind;
            if (!kind || !NODE_KIND_META[kind]) return;
            const bounds = wrapper.current?.getBoundingClientRect();
            if (!bounds) return;

            // Approximate placement: the node is immediately draggable, and skipping
            // the viewport transform keeps this free of a provider wrapper.
            const id = mintNodeId(flow, kind);
            const node = makeNode(
                kind,
                id,
                { x: event.clientX - bounds.left - 116, y: event.clientY - bounds.top - 40 },
                offered.current,
            );
            onChange({ ...flow, nodes: [...flow.nodes, node] });
            onSelect(id);
        },
        [flow, onChange, onSelect, onRunOutlookDrag, triggerAt],
    );

    return (
        <div className={`canvas-wrap${mailDrag ? ' email-drag' : ''}`} ref={wrapper}>
            <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_e, node) => onSelect(node.id)}
                onNodeContextMenu={(e, node) => {
                    const { flowNode } = node.data as NodeData;
                    if (flowNode.kind !== 'trigger.outlook') return;
                    e.preventDefault();
                    setMenu({ node: flowNode, x: e.clientX, y: e.clientY });
                }}
                onPaneClick={() => onSelect(null)}
                onDrop={onDrop}
                onDragOver={onDragOver}
                // Moving from an element onto its child also fires a leave; only
                // leaving the canvas altogether clears the target.
                onDragLeave={(e) => {
                    if (e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) return;
                    setDropTarget(null);
                    setMailDrag(false);
                }}
                fitView
                fitViewOptions={{ maxZoom: 1 }}
                minZoom={0.2}
                maxZoom={2.5}
                // Delete alongside Backspace, for whichever key the keyboard has. React
                // Flow ignores both while a field has focus, so the inspector is safe.
                deleteKeyCode={['Backspace', 'Delete']}
                // A wire is thin; this is the invisible width that catches the pointer.
                defaultEdgeOptions={{ animated: false, interactionWidth: 24 }}
            >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1} color={cssVar('--grid')}/>
                <Controls showInteractive={false}/>
                <MiniMap
                    pannable
                    zoomable
                    maskColor={cssVar('--scrim')}
                    nodeColor={(n) => cssVar(`--k-${NODE_KIND_META[(n.data as NodeData).flowNode.kind].token}`)}
                />
            </ReactFlow>

            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    label={menu.node.name}
                    items={[
                        {
                            label: 'Run the email selected in Outlook',
                            onSelect: () => onRunOutlookSelected(menu.node.id),
                        },
                    ]}
                    onClose={() => setMenu(null)}
                />
            )}

            {flow.nodes.length === 0 && (
                <div className="canvas-empty">
                    <div className="empty">
                        Nothing on the canvas yet. Drag an <b>Outlook Trigger</b> in from the left to
                        say which mailbox this flow watches — a flow can hold several, or none at all.
                    </div>
                </div>
            )}
        </div>
    );
}
