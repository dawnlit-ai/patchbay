import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Flow, type FlowNode, NODE_KIND_META, type NodeKind } from '@shared/flow';
import { type Run, type RunSummary, toSummary } from '@shared/trace';
import {
    type AboutInfo,
    type AgentControlStatus,
    type EngineStatus,
    type Settings,
    skillRef,
    type SkillScope,
    type SkillSummary,
} from '@shared/settings';
import { ConfirmDialog, type Question } from './components/ConfirmDialog';
import { type CanvasHighlight, FlowCanvas } from './components/FlowCanvas';
import { Inspector } from './components/Inspector';
import { NameDialog } from './components/NameDialog';
import { RunsPanel } from './components/RunsPanel';
import { SkillLibrary } from './components/SkillLibrary';
import { SettingsPanel } from './components/SettingsPanel';
import { TestRunDialog } from './components/TestRunDialog';
import { WindowControls } from './components/WindowControls';

const PALETTE: NodeKind[] = ['trigger.outlook', 'categorizer', 'processor', 'terminal'];

/** The three things the app asks a flow name for, and what each does with one. */
type NamingMode = 'new' | 'rename' | 'duplicate';

interface NamingSpec {
    title: string;
    confirmLabel: string;
    /** Filled in and selected, so the common answer is one keystroke away. */
    initial: string;

    run(name: string): void;
}

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
 * of switching themes. Done before React renders rather than in an effect: the
 * canvas reads the same tokens as it draws, and an effect would leave it a frame
 * behind.
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
    /** Which name the dialog is asking for, if it is open. */
    const [naming, setNaming] = useState<NamingMode | null>(null);
    /** The question ConfirmDialog is showing, if any, and who awaits the answer. */
    const [question, setQuestion] = useState<Question | null>(null);
    const answering = useRef<((ok: boolean) => void) | null>(null);
    const [runsCollapsed, setRunsCollapsed] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [theme, setThemeState] = useState<Theme>(initialTheme);
    const [about, setAbout] = useState<AboutInfo | null>(null);
    /** The app's own MCP server, so Settings can show whether it is listening. */
    const [agentControl, setAgentControl] = useState<AgentControlStatus | null>(null);

    const setTheme = useCallback((next: Theme) => {
        applyTheme(next);
        setThemeState(next);
        try {
            localStorage.setItem(THEME_KEY, next);
        } catch {
            // A machine that refuses storage still themes correctly for this session.
        }
    }, []);

    /** Every library belongs to a flow, so switching flows swaps the list. */
    const flowId = flow?.id ?? null;
    const refreshSkills = useCallback(() => {
        if (!flowId) {
            setSkills([]);
            return;
        }
        void window.api.skills.list(flowId).then(setSkills);
    }, [flowId]);

    useEffect(refreshSkills, [refreshSkills]);

    const refreshRuns = useCallback(() => {
        void window.api.runs.list(100).then(setRuns);
    }, []);

    // ── Boot ───────────────────────────────────────────────────────────────

    useEffect(() => {
        void (async () => {
            const [loadedFlows, loadedSettings, loadedStatus, loadedAbout, loadedAgent] = await Promise.all([
                window.api.flows.list(),
                window.api.settings.get(),
                window.api.engine.status(),
                window.api.about(),
                window.api.agentControl.status(),
            ]);
            setAbout(loadedAbout);
            setFlows(loadedFlows);
            setFlow(loadedFlows[0] ?? null);
            setSettings(loadedSettings);
            setStatus(loadedStatus);
            setAgentControl(loadedAgent);
            refreshRuns();
        })();
    }, [refreshRuns]);

    // Live updates. An open run stays open and keeps filling in; otherwise the
    // newest becomes the one on screen, so a flow shows its work without a click.
    useEffect(() => {
        const offRun = window.api.on.runUpdated((run) => {
            setRuns((prev) => [toSummary(run), ...prev.filter((r) => r.id !== run.id)]);
            setSelectedRun((current) => (!current || current.id === run.id ? run : current));
        });
        const offStatus = window.api.on.engineStatus((next) => setStatus(next));
        const offAgent = window.api.on.agentControl((next) => setAgentControl(next));
        return () => {
            offRun();
            offStatus();
            offAgent();
        };
    }, []);

    // ── Flow editing ───────────────────────────────────────────────────────

    // Every edit is written for you. There is no draft state to lose, so nothing
    // asks about unsaved changes and nothing has to be pressed to keep work.
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** The flow a queued write would put on disk, or null once one has. */
    const queued = useRef<Flow | null>(null);

    const writeFlow = useCallback((next: Flow) => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = null;
        queued.current = null;
        void window.api.flows.save(next).catch((e: Error) => {
            setError(e.message);
            // Left queued unless a newer edit already took its place, so the next
            // write — or leaving the flow — tries again.
            queued.current ??= next;
        });
    }, []);

    /** Write a queued edit now, rather than when its timer says so. */
    const flushSave = useCallback(() => {
        if (queued.current) writeFlow(queued.current);
    }, [writeFlow]);

    /**
     * An agent driving the app through its MCP server writes to the same files
     * this window does, so the moment it does, what is on screen is behind. An
     * edit of ours still in the queue goes out first; then the library is re-read
     * and the flow on screen becomes whatever the store now holds under its id —
     * or the first one left, if the agent deleted it.
     */
    useEffect(
        () =>
            window.api.on.workspaceChanged((change) => {
                if (change.skills) refreshSkills();
                if (!change.flows) return;
                flushSave();
                void window.api.flows.list().then((list) => {
                    setFlows(list);
                    setFlow((current) => list.find((f) => f.id === current?.id) ?? list[0] ?? null);
                });
            }),
        [flushSave, refreshSkills],
    );

    const updateFlow = useCallback(
        (next: Flow) => {
            setFlow(next);
            setFlows((prev) => prev.map((f) => (f.id === next.id ? next : f)));
            queued.current = next;
            // Debounced: dragging fires a change per frame, and each save is a file write.
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => writeFlow(next), 400);
        },
        [writeFlow],
    );

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

    /**
     * A skill that changed library changed name with it — `global:x` one way, a
     * bare `x` the other — so every Processor that ticked it is re-pointed. Only
     * the flow on screen: the move itself is what tells other flows it is gone.
     */
    const relabelSkill = useCallback(
        (from: SkillScope, to: SkillScope, name: string) => {
            if (!flow) return;
            const before = skillRef(from, name);
            const after = skillRef(to, name);
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
            if (changed) updateFlow({ ...flow, nodes });
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

    /**
     * Asks a yes/no question and resolves to the answer, the way `window.confirm`
     * returned one. Through ConfirmDialog rather than the native box, which leaves
     * the page unable to take focus again once it closes: clicks land nowhere and
     * the flow `select` refuses to open until another window has had focus.
     */
    const ask = (next: Question): Promise<boolean> =>
        new Promise((resolve) => {
            answering.current = resolve;
            setQuestion(next);
        });

    const answer = (ok: boolean): void => {
        setQuestion(null);
        answering.current?.(ok);
        answering.current = null;
    };

    const toggleWatching = async (): Promise<void> => {
        setError(null);
        try {
            const next = status?.running ? await window.api.engine.stop() : await window.api.engine.start();
            setStatus(next);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    /**
     * A queued write belongs to the flow being left, so anything about to put
     * another one on screen sends it out first. That is all leaving takes now:
     * every edit reaches disk, so there is never a draft to ask about.
     */
    const selectFlow = (id: string): void => {
        if (id === flow?.id) return;
        const next = flows.find((f) => f.id === id);
        if (!next) return;
        flushSave();
        setFlow(next);
        setSelectedNodeId(null);
    };

    const newFlow = async (name: string): Promise<void> => {
        setError(null);
        flushSave();
        try {
            const created = await window.api.flows.create(name);
            setFlows((prev) => [...prev, created]);
            setFlow(created);
            setSelectedNodeId(null);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    /** The name is part of the flow, so a rename saves itself like any other edit. */
    const renameFlow = (name: string): void => {
        if (!flow || name === flow.name) return;
        updateFlow({ ...flow, name });
    };

    /**
     * A copy of this flow, its own skill library included, opened in place of the
     * original. The graph goes over as it stands on screen rather than as the file
     * has it, so a copy taken mid-edit is the flow you were looking at.
     */
    const duplicateFlow = async (name: string): Promise<void> => {
        if (!flow) return;
        setError(null);
        flushSave();
        try {
            const copy = await window.api.flows.duplicate(flow, name);
            setFlows((prev) => [...prev, copy]);
            setFlow(copy);
            setSelectedNodeId(null);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    /** Nothing in the app undoes this, so it asks first. */
    const deleteFlow = async (): Promise<void> => {
        if (!flow) return;
        const ok = await ask({
            title: 'Delete flow',
            // Deleting the last flow is allowed: main seeds an empty one in its place,
            // as on a fresh install. Said here so none appears unbidden.
            message:
                flows.length === 1
                    ? `Delete “${flow.name}”? It is the only flow, so an empty one takes its place. This cannot be undone.`
                    : `Delete “${flow.name}”? This cannot be undone.`,
            confirmLabel: 'Delete',
        });
        if (!ok) return;
        setError(null);
        // A queued write belongs to the flow being deleted; left to fire, it would
        // put the file straight back.
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = null;
        queued.current = null;
        try {
            await window.api.flows.remove(flow.id);
            const list = await window.api.flows.list();
            setFlows(list);
            setFlow(list[0] ?? null);
            setSelectedNodeId(null);
            // The watcher reads flows from disk, so a deleted one drops out of the
            // count on its own — asking now just spares the pill the wait.
            setStatus(await window.api.engine.status());
        } catch (e) {
            setError((e as Error).message);
        }
    };

    const loadFlow = async (): Promise<void> => {
        setError(null);
        try {
            const imported = await window.api.flows.pickAndImport();
            if (!imported) return;
            flushSave();
            setFlows((prev) => [...prev.filter((f) => f.id !== imported.id), imported]);
            setFlow(imported);
            setSelectedNodeId(null);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    const clearRuns = async (): Promise<void> => {
        const ok = await ask({
            title: 'Clear runs',
            message: 'Delete every stored run? Their traces and saved files go too.',
            confirmLabel: 'Delete',
        });
        if (!ok) return;
        setError(null);
        try {
            await window.api.runs.clear();
            setRuns([]);
            setSelectedRun(null);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    /** Writes what is on screen, unsaved edits included. */
    const exportFlow = async (): Promise<void> => {
        if (!flow) return;
        setError(null);
        try {
            await window.api.flows.pickAndExport(flow);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    if (!flow || !settings) {
        return <div className="empty loading">Loading…</div>;
    }

    const watching = status?.running === true;

    /** What the one name dialog asks for, whichever of the three opened it. */
    const namingModes: Record<NamingMode, NamingSpec> = {
        new: {
            title: 'New flow',
            confirmLabel: 'Create',
            initial: 'New flow',
            run: (name) => void newFlow(name),
        },
        rename: {
            title: 'Rename flow',
            confirmLabel: 'Rename',
            initial: flow.name,
            run: renameFlow,
        },
        duplicate: {
            title: 'Duplicate flow',
            confirmLabel: 'Duplicate',
            initial: `${flow.name} copy`,
            run: (name) => void duplicateFlow(name),
        },
    };

    return (
        <div className="app">
            <div className="topbar">
                <span className="brand">
                    <span className="name">Patchbay</span>
                    <span className="by">
                        by <b>Dawnlit</b>
                    </span>
                </span>

                <select value={flow.id} onChange={(e) => selectFlow(e.target.value)}>
                    {flows.map((f) => (
                        <option key={f.id} value={f.id}>
                            {f.name}
                        </option>
                    ))}
                </select>
                <button className="ghost" title="Rename this flow" onClick={() => setNaming('rename')}>
                    ✎ Rename
                </button>
                <button
                    className="ghost"
                    title="Make a copy of this flow, its own skills included"
                    onClick={() => setNaming('duplicate')}
                >
                    ⧉ Duplicate
                </button>
                <button className="danger" title="Delete this flow" onClick={() => void deleteFlow()}>
                    Delete
                </button>
                <button onClick={() => setNaming('new')}>New flow</button>
                <button title="Open a flow file and add it to the library" onClick={() => void loadFlow()}>
                    Load…
                </button>
                <button title="Write this flow out to a file" onClick={() => void exportFlow()}>
                    Export…
                </button>
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
                    {watching ? `Watching ${status?.watching.length ?? 0} mailbox(es)` : 'Not watching'}
                </span>
                <button className={watching ? '' : 'primary'} onClick={() => void toggleWatching()}>
                    {watching ? 'Stop' : 'Start watching'}
                </button>

                <WindowControls/>
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
                        Every trigger you place starts one run per email it sees, so a flow can
                        watch several folders at once — or none. Each node hands the email out of
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
                        onClear={() => void clearRuns()}
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
                        {tab === 'skills' && (
                            <SkillLibrary
                                flowId={flow.id}
                                flowName={flow.name}
                                skills={skills}
                                otherFlowCount={flows.length - 1}
                                onRefresh={refreshSkills}
                                onMoved={relabelSkill}
                            />
                        )}
                        {tab === 'settings' && (
                            <SettingsPanel
                                settings={settings}
                                about={about}
                                agentControl={agentControl}
                                onSave={(next) => {
                                    void window.api.settings.save(next).then(setSettings);
                                }}
                                onRegenerateToken={() => {
                                    void window.api.agentControl.regenerateToken().then(setAgentControl);
                                }}
                            />
                        )}
                    </div>
                </div>
            </div>

            {naming && (
                <NameDialog
                    title={namingModes[naming].title}
                    label="Flow name"
                    initial={namingModes[naming].initial}
                    confirmLabel={namingModes[naming].confirmLabel}
                    onCancel={() => setNaming(null)}
                    onConfirm={(name) => {
                        setNaming(null);
                        namingModes[naming].run(name);
                    }}
                />
            )}

            {question && (
                <ConfirmDialog {...question} onCancel={() => answer(false)} onConfirm={() => answer(true)}/>
            )}

            {testing && (
                <TestRunDialog
                    flow={flow}
                    onClose={() => setTesting(false)}
                    onRun={(nodeId, email) => {
                        setTesting(false);
                        setSelectedRun(null);
                        void window.api.engine
                            .testRun(flow.id, nodeId, email)
                            .catch((e: Error) => setError(e.message));
                    }}
                />
            )}
        </div>
    );
}
