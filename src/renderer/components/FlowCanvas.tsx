import type { JSX } from 'react';
import { useCallback, useMemo, useRef } from 'react';
import {
    Background,
    BackgroundVariant,
    type Connection,
    Controls,
    type Edge,
    type EdgeChange,
    Handle,
    MiniMap,
    type Node,
    type NodeChange,
    type NodeProps,
    Position,
    ReactFlow,
} from '@xyflow/react';
import {
    type Flow,
    type FlowNode,
    hasInput,
    makeNode,
    NODE_KIND_META,
    type NodeKind,
    outputPorts,
} from '@shared/flow';
import type { Pass } from '@shared/trace';

/**
 * The canvas. The Flow object is the single source of truth: React Flow's node
 * array is derived on every render and every interaction translates straight back
 * into a Flow edit, so no second copy of the graph can drift.
 */

export interface CanvasHighlight {
    /** Pass by node id, for the run currently being inspected. */
    passes: Map<string, Pass>;
    takenEdges: Set<string>;
}

interface NodeData extends Record<string, unknown> {
    flowNode: FlowNode;
    pass?: Pass;
}

function NodeCard({ data, selected }: NodeProps): JSX.Element {
    const { flowNode, pass } = data as NodeData;
    const meta = NODE_KIND_META[flowNode.kind];
    const ports = outputPorts(flowNode);

    const classes = ['node', `kind-${meta.token}`];
    if (selected) classes.push('selected');
    if (pass) classes.push(pass.status === 'error' ? 'failed' : 'visited');

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

const nodeTypes = { card: NodeCard };

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
}

export function FlowCanvas({
                               flow,
                               selectedNodeId,
                               highlight,
                               onChange,
                               onSelect,
                           }: FlowCanvasProps): JSX.Element {
    const wrapper = useRef<HTMLDivElement>(null);

    const rfNodes: Node[] = useMemo(
        () =>
            flow.nodes.map((n) => ({
                id: n.id,
                type: 'card',
                position: n.position,
                selected: n.id === selectedNodeId,
                data: { flowNode: n, pass: highlight?.passes.get(n.id) } satisfies NodeData,
            })),
        [flow.nodes, selectedNodeId, highlight],
    );

    const rfEdges: Edge[] = useMemo(
        () =>
            flow.edges.map((e) => ({
                id: e.id,
                source: e.source,
                sourceHandle: e.sourceHandle,
                target: e.target,
                targetHandle: 'in',
                className: highlight?.takenEdges.has(e.id) ? 'taken' : undefined,
            })),
        [flow.edges, highlight],
    );

    const onNodesChange = useCallback(
        (changes: NodeChange[]) => {
            let nodes = flow.nodes;
            let edges = flow.edges;
            let touched = false;

            for (const change of changes) {
                if (change.type === 'position' && change.position) {
                    const { position } = change;
                    nodes = nodes.map((n) => (n.id === change.id ? { ...n, position } : n));
                    touched = true;
                } else if (change.type === 'remove') {
                    // The trigger is the entry point: removing it would leave a flow that
                    // can never start, so it stays put.
                    const target = nodes.find((n) => n.id === change.id);
                    if (target?.kind === 'trigger.outlook') continue;
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
            const id = `${connection.source}:${connection.sourceHandle}->${connection.target}`;
            // One edge per output port: a decision leading two places would make the
            // recorded path ambiguous.
            const edges = flow.edges.filter(
                (e) => !(e.source === connection.source && e.sourceHandle === connection.sourceHandle),
            );
            edges.push({
                id,
                source: connection.source,
                sourceHandle: connection.sourceHandle,
                target: connection.target,
            });
            onChange({ ...flow, edges });
        },
        [flow, onChange],
    );

    const onDrop = useCallback(
        (event: React.DragEvent) => {
            event.preventDefault();
            const kind = event.dataTransfer.getData('application/flow-node') as NodeKind;
            if (!kind || !NODE_KIND_META[kind]) return;
            const bounds = wrapper.current?.getBoundingClientRect();
            if (!bounds) return;

            // Approximate placement: the node is immediately draggable, and skipping
            // the viewport transform keeps this free of a provider wrapper.
            const id = `${kind.split('.')[0]}-${Math.random().toString(36).slice(2, 8)}`;
            const node = makeNode(kind, id, {
                x: event.clientX - bounds.left - 116,
                y: event.clientY - bounds.top - 40,
            });
            onChange({ ...flow, nodes: [...flow.nodes, node] });
            onSelect(id);
        },
        [flow, onChange, onSelect],
    );

    return (
        <div className="canvas-wrap" ref={wrapper}>
            <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_e, node) => onSelect(node.id)}
                onPaneClick={() => onSelect(null)}
                onDrop={onDrop}
                onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                }}
                fitView
                defaultEdgeOptions={{ animated: false }}
            >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1} color={cssVar('--grid')}/>
                <Controls showInteractive={false}/>
                <MiniMap
                    pannable
                    zoomable
                    maskColor={cssVar('--scrim')}
                    style={{ background: cssVar('--input-bg'), border: `1px solid ${cssVar('--line')}` }}
                    nodeColor={(n) => cssVar(`--k-${NODE_KIND_META[(n.data as NodeData).flowNode.kind].token}`)}
                />
            </ReactFlow>
        </div>
    );
}
