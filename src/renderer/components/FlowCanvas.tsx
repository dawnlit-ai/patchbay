import type { JSX } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
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
    connectNodes,
    type Flow,
    type FlowNode,
    hasInput,
    makeNode,
    mintNodeId,
    NODE_KIND_META,
    type NodeKind,
    outputPorts,
} from '@shared/flow';
import type { Pass } from '@shared/trace';
import type { OutlookDrag } from '@shared/ipc';

/**
 * The canvas. The Flow is the only source of truth: React Flow's nodes are derived
 * from it every render, and every interaction becomes a Flow edit.
 */

export interface CanvasHighlight {
    /** Pass by node id, for the run currently being inspected. */
    passes: Map<string, Pass>;
    takenEdges: Set<string>;
}

interface NodeData extends Record<string, unknown> {
    flowNode: FlowNode;
    pass?: Pass;
    /**
     * While an email is being dragged: `ready` on every trigger it could start a
     * run at, `over` on the one it would land on if let go now.
     */
    drop?: 'ready' | 'over';
}

interface EdgeData extends Record<string, unknown> {
    onRemove(edgeId: string): void;
}

function NodeCard({ data, selected }: NodeProps): JSX.Element {
    const { flowNode, pass, drop } = data as NodeData;
    const meta = NODE_KIND_META[flowNode.kind];
    const ports = outputPorts(flowNode);

    const classes = ['node', `kind-${meta.token}`];
    if (selected) classes.push('selected');
    if (pass) classes.push(pass.status === 'error' ? 'failed' : 'visited');
    if (drop) classes.push(`drop-${drop}`);

    return (
        <div className={classes.join(' ')}>
            {hasInput(flowNode.kind) && <Handle type="target" position={Position.Left} id="in"/>}

            <div className="node-head">
                <span className="dot"/>
                <span className="kind">{meta.label}</span>
                {pass && <span className="seq">#{pass.seq}</span>}
            </div>

            <div className="node-title">{flowNode.name}</div>
            <div className="node-sub">{describe(flowNode)}</div>

            {ports.length > 0 && (
                <div className="node-ports">
                    {ports.map((port) => (
                        <div
                            key={port.id}
                            className={`node-port ${port.tone}${pass?.outPort === port.id ? ' taken' : ''}`}
                        >
                            {port.label}
                            <Handle
                                type="source"
                                position={Position.Right}
                                id={port.id}
                                className={pass?.outPort === port.id ? 'taken-handle' : undefined}
                            />
                        </div>
                    ))}
                </div>
            )}

            {pass && <div className="node-note">{pass.summary}</div>}
        </div>
    );
}

/** The one-line subtitle on a node card: its configuration at a glance. */
function describe(node: FlowNode): string {
    const c = node.config;
    switch (c.kind) {
        case 'trigger.outlook':
            return c.account
                ? `${c.account}${c.folder ? ` \\ ${c.folder}` : ''} · every ${c.pollSeconds}s`
                : 'No mailbox selected yet';
        case 'categorizer':
            return `${c.categories.length} categor${c.categories.length === 1 ? 'y' : 'ies'} · ${c.model}`;
        case 'processor':
            return c.skills.length > 0
                ? `skills: ${c.skills.join(', ')}`
                : 'No skill assigned — instruction only';
        case 'terminal':
            return c.moveToFolder ? `${c.disposition} · file in ${c.moveToFolder}` : c.disposition;
    }
}

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

    onChange(flow: Flow): void;

    onSelect(nodeId: string | null): void;

    /** Something dragged in from outside the app — an email out of Outlook — was dropped on a trigger. */
    onRunOutlookDrag(nodeId: string, drag: OutlookDrag): void;
}

/** What the node palette puts on a drag: the kind of node to place. */
export const NODE_DRAG_TYPE = 'application/flow-node';

export function FlowCanvas({
                               flow,
                               selectedNodeId,
                               highlight,
                               onChange,
                               onSelect,
                               onRunOutlookDrag,
                           }: FlowCanvasProps): JSX.Element {
    const wrapper = useRef<HTMLDivElement>(null);
    /** The trigger a dragged email is over. Only read while `mailDrag` holds. */
    const [dropTarget, setDropTarget] = useState<string | null>(null);
    /** Something from outside the app is being dragged over the canvas — an email out of Outlook, most likely. */
    const [mailDrag, setMailDrag] = useState(false);
    /**
     * Each card's last measured size, handed back on every rebuilt node. React Flow
     * hides a node without one, which blanked the canvas on every frame of a drag.
     */
    const measured = useRef(new Map<string, { width: number; height: number }>());

    const rfNodes: Node[] = useMemo(
        () =>
            flow.nodes.map((n) => {
                let drop: NodeData['drop'];
                if (mailDrag && n.kind === 'trigger.outlook') drop = n.id === dropTarget ? 'over' : 'ready';
                return {
                    id: n.id,
                    type: 'card',
                    position: n.position,
                    measured: measured.current.get(n.id),
                    selected: n.id === selectedNodeId,
                    data: { flowNode: n, pass: highlight?.passes.get(n.id), drop } satisfies NodeData,
                };
            }),
        [flow.nodes, selectedNodeId, highlight, mailDrag, dropTarget],
    );

    const removeEdge = useCallback(
        (edgeId: string) => onChange({ ...flow, edges: flow.edges.filter((e) => e.id !== edgeId) }),
        [flow, onChange],
    );

    const rfEdges: Edge[] = useMemo(
        () =>
            flow.edges.map((e) => ({
                id: e.id,
                type: 'wire',
                source: e.source,
                sourceHandle: e.sourceHandle,
                target: e.target,
                targetHandle: 'in',
                className: highlight?.takenEdges.has(e.id) ? 'taken' : undefined,
                data: { onRemove: removeEdge } satisfies EdgeData,
            })),
        [flow.edges, highlight, removeEdge],
    );

    const onNodesChange = useCallback(
        (changes: NodeChange[]) => {
            let nodes = flow.nodes;
            let edges = flow.edges;
            let touched = false;

            for (const change of changes) {
                if (change.type === 'dimensions' && change.dimensions) {
                    measured.current.set(change.id, change.dimensions);
                } else if (change.type === 'position' && change.position) {
                    const { position } = change;
                    nodes = nodes.map((n) => (n.id === change.id ? { ...n, position } : n));
                    touched = true;
                } else if (change.type === 'remove') {
                    measured.current.delete(change.id);
                    nodes = nodes.filter((n) => n.id !== change.id);
                    edges = edges.filter((e) => e.source !== change.id && e.target !== change.id);
                    touched = true;
                    if (selectedNodeId === change.id) onSelect(null);
                }
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
            const node = makeNode(kind, id, {
                x: event.clientX - bounds.left - 116,
                y: event.clientY - bounds.top - 40,
            });
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
