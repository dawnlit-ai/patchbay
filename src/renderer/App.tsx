import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Flow, type FlowNode, NODE_KIND_META, type NodeKind } from '@shared/flow';
import { type Run, type RunSummary, toSummary } from '@shared/trace';
import type { AboutInfo, EngineStatus, Settings, SkillSummary } from '@shared/settings';
import { type CanvasHighlight, FlowCanvas } from './components/FlowCanvas';
import { Inspector } from './components/Inspector';
import { RunsPanel } from './components/RunsPanel';
import { SkillLibrary } from './components/SkillLibrary';
import { SettingsPanel } from './components/SettingsPanel';
import { TestRunDialog } from './components/TestRunDialog';

const PALETTE: NodeKind[] = ['categorizer', 'processor', 'terminal'];

type Theme = 'light' | 'dark';

const THEME_KEY = 'patchbay.theme';

/** Light unless the user has chosen otherwise; the choice is per machine. */
function readTheme(): Theme {
    try {
        return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
    } catch {
        return 'light';
    }
}

/**
 * The stylesheet keys every colour off this attribute, so setting it is the whole
 * of what switching themes does. It happens before React renders rather than in an
 * effect afterwards, because the canvas reads those same tokens as it draws and an
 * effect would leave it a frame behind.
 */
function applyTheme(theme: Theme): void {
    document.documentElement.dataset.theme = theme;
}

const initialTheme = readTheme();
applyTheme(initialTheme);

export function App(): JSX.Element {
    const [flows, setFlows] = useState<Flow[]>([]);
    const [flow, setFlow] = useState<Flow | null>(null);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [skills, setSkills] = useState<SkillSummary[]>([]);
    const [settings, setSettings] = useState<Settings | null>(null);
    const [runs, setRuns] = useState<RunSummary[]>([]);
    const [selectedRun, setSelectedRun] = useState<Run | null>(null);
    const [status, setStatus] = useState<EngineStatus | null>(null);
    const [tab, setTab] = useState<'inspector' | 'skills' | 'settings'>('inspector');
    const [testing, setTesting] = useState(false);
    const [runsCollapsed, setRunsCollapsed] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [theme, setThemeState] = useState<Theme>(initialTheme);
    const [about, setAbout] = useState<AboutInfo | null>(null);

    const setTheme = useCallback((next: Theme) => {
        applyTheme(next);
        setThemeState(next);
        try {
            localStorage.setItem(THEME_KEY, next);
        } catch {
            // A machine that refuses storage still themes correctly for this session.
        }
    }, []);

    const refreshSkills = useCallback(() => {
        void window.api.skills.list().then(setSkills);
    }, []);

    const refreshRuns = useCallback(() => {
        void window.api.runs.list(100).then(setRuns);
    }, []);

    // ── Boot ───────────────────────────────────────────────────────────────

    useEffect(() => {
        void (async () => {
            const [loadedFlows, loadedSettings, loadedStatus, loadedAbout] = await Promise.all([
                window.api.flows.list(),
                window.api.settings.get(),
                window.api.engine.status(),
                window.api.about(),
            ]);
            setAbout(loadedAbout);
            setFlows(loadedFlows);
            setFlow(loadedFlows[0] ?? null);
            setSettings(loadedSettings);
            setStatus(loadedStatus);
            refreshSkills();
            refreshRuns();
        })();
    }, [refreshRuns, refreshSkills]);

    // Live updates. A run that is already open stays open and keeps filling in;
    // otherwise the newest run becomes the one on screen, so starting a flow shows
    // its work without anyone having to click.
    useEffect(() => {
        const offRun = window.api.on.runUpdated((run) => {
            setRuns((prev) => [toSummary(run), ...prev.filter((r) => r.id !== run.id)]);
            setSelectedRun((current) => (!current || current.id === run.id ? run : current));
        });
        const offStatus = window.api.on.engineStatus((next) => setStatus(next));
        return () => {
            offRun();
            offStatus();
        };
    }, []);

    // ── Flow editing ───────────────────────────────────────────────────────

    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const updateFlow = useCallback((next: Flow) => {
        setFlow(next);
        setFlows((prev) => prev.map((f) => (f.id === next.id ? next : f)));
        // Debounced: dragging a node fires a change per animation frame, and each
        // save is a file write.
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            void window.api.flows.save(next).catch((e: Error) => setError(e.message));
        }, 400);
    }, []);

    const selectedNode = useMemo(
        () => flow?.nodes.find((n) => n.id === selectedNodeId) ?? null,
        [flow, selectedNodeId],
    );

    const updateNode = useCallback(
        (node: FlowNode) => {
            if (!flow) return;
            updateFlow({ ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? node : n)) });
        },
        [flow, updateFlow],
    );

    const deleteNode = useCallback(
        (nodeId: string) => {
            if (!flow) return;
            updateFlow({
                ...flow,
                nodes: flow.nodes.filter((n) => n.id !== nodeId),
                edges: flow.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
            });
            setSelectedNodeId(null);
        },
        [flow, updateFlow],
    );

    // ── Run highlighting ───────────────────────────────────────────────────

    const highlight: CanvasHighlight | null = useMemo(() => {
        if (!selectedRun || !flow || selectedRun.flowId !== flow.id) return null;
        return {
            passes: new Map(selectedRun.passes.map((p) => [p.nodeId, p])),
            takenEdges: new Set(selectedRun.edgePath),
        };
    }, [selectedRun, flow]);

    // ── Actions ────────────────────────────────────────────────────────────

    const toggleWatching = async (): Promise<void> => {
        setError(null);
        try {
            const next = status?.running ? await window.api.engine.stop() : await window.api.engine.start();
            setStatus(next);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    const newFlow = async (): Promise<void> => {
        const name = window.prompt('Name this flow:', 'New flow');
        if (!name) return;
        const created = await window.api.flows.create(name);
        setFlows((prev) => [...prev, created]);
        setFlow(created);
        setSelectedNodeId(null);
    };

    if (!flow || !settings) {
        return <div className="empty loading">Loading…</div>;
    }

    const watching = status?.running === true;

    return (
        <div className="app">
            <div className="topbar">
                <span className="brand">
                    <span className="name">Patchbay</span>
                    <span className="by">
                        by <b>Dawnlit</b>
                    </span>
                </span>

                <select
                    value={flow.id}
                    onChange={(e) => {
                        const next = flows.find((f) => f.id === e.target.value);
                        if (next) {
                            setFlow(next);
                            setSelectedNodeId(null);
                        }
                    }}
                >
                    {flows.map((f) => (
                        <option key={f.id} value={f.id}>
                            {f.name}
                        </option>
                    ))}
                </select>
                <button onClick={() => void newFlow()}>New flow</button>
                <button onClick={() => setTesting(true)}>Test run…</button>
                <button
                    className="ghost"
                    title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
                    onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                >
                    {theme === 'light' ? '◐ Dark' : '◑ Light'}
                </button>

                <span className="spacer"/>

                {status?.lastError && <span className="badge err">{status.lastError}</span>}
                <span className="status-pill">
                    <span className={`dot ${watching ? 'live' : ''}`}/>
                    {watching ? `Watching ${status?.watching.length ?? 0} flow(s)` : 'Not watching'}
                </span>
                <button className={watching ? '' : 'primary'} onClick={() => void toggleWatching()}>
                    {watching ? 'Stop' : 'Start watching'}
                </button>
            </div>

            {error && <div className="err-banner inset">{error}</div>}

            <div className="body">
                <div className="side">
                    <div className="section-title">Drag onto the canvas</div>
                    {PALETTE.map((kind) => {
                        const meta = NODE_KIND_META[kind];
                        return (
                            <div
                                key={kind}
                                className={`palette-item kind-${meta.token}`}
                                draggable
                                onDragStart={(e) => {
                                    e.dataTransfer.setData('application/flow-node', kind);
                                    e.dataTransfer.effectAllowed = 'move';
                                }}
                            >
                                <strong>{meta.label}</strong>
                                <span>{meta.blurb}</span>
                            </div>
                        );
                    })}

                    <div className="section-title">How a run works</div>
                    <div className="side-note">
                        The trigger starts one run per email. Each node hands the email out of
                        exactly one port, and the engine follows the edge attached to it. That
                        sequence is the run’s path — select a run below to light it up here.
                    </div>
                </div>

                <div className="center">
                    <FlowCanvas
                        flow={flow}
                        selectedNodeId={selectedNodeId}
                        highlight={highlight}
                        onChange={updateFlow}
                        onSelect={setSelectedNodeId}
                    />
                    <RunsPanel
                        runs={runs}
                        selected={selectedRun}
                        collapsed={runsCollapsed}
                        onToggleCollapsed={() => setRunsCollapsed((v) => !v)}
                        onSelect={(id) => void window.api.runs.get(id).then(setSelectedRun)}
                        onClear={() => {
                            if (!window.confirm('Delete every stored run?')) return;
                            void window.api.runs.clear().then(() => {
                                setRuns([]);
                                setSelectedRun(null);
                            });
                        }}
                        onReveal={() => void window.api.runs.revealFolder()}
                        onCancel={(runId) => void window.api.engine.cancel(runId)}
                    />
                </div>

                <div className="side right">
                    <div className="tabs">
                        <button className={tab === 'inspector' ? 'active' : ''} onClick={() => setTab('inspector')}>
                            Node
                        </button>
                        <button className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>
                            Skills
                        </button>
                        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
                            Settings
                        </button>
                    </div>
                    <div className="tab-body">
                        {tab === 'inspector' && (
                            <Inspector
                                node={selectedNode}
                                skills={skills}
                                onChange={updateNode}
                                onDelete={deleteNode}
                            />
                        )}
                        {tab === 'skills' && <SkillLibrary skills={skills} onRefresh={refreshSkills}/>}
                        {tab === 'settings' && (
                            <SettingsPanel
                                settings={settings}
                                about={about}
                                onSave={(next) => {
                                    void window.api.settings.save(next).then(setSettings);
                                }}
                            />
                        )}
                    </div>
                </div>
            </div>

            {testing && (
                <TestRunDialog
                    flow={flow}
                    onClose={() => setTesting(false)}
                    onRun={(email) => {
                        setTesting(false);
                        setSelectedRun(null);
                        void window.api.engine.testRun(flow.id, email).catch((e: Error) => setError(e.message));
                    }}
                />
            )}
        </div>
    );
}
