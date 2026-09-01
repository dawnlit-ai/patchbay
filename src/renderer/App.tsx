import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Flow, type FlowNode, NODE_KIND_META, type NodeKind } from '@shared/flow';
import { type Run, type RunSummary, toSummary } from '@shared/trace';
import type { AboutInfo, EngineStatus, Settings, SkillSummary } from '@shared/settings';
import { ConfirmDialog, type Question } from './components/ConfirmDialog';
import { type CanvasHighlight, FlowCanvas } from './components/FlowCanvas';
import { Inspector } from './components/Inspector';
import { NameDialog } from './components/NameDialog';
import { RunsPanel } from './components/RunsPanel';
import { SkillLibrary } from './components/SkillLibrary';
import { SettingsPanel } from './components/SettingsPanel';
import { TestRunDialog } from './components/TestRunDialog';
import { WindowControls } from './components/WindowControls';

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
    const [naming, setNaming] = useState<'new' | 'rename' | null>(null);
    /** The question ConfirmDialog is showing, if any, and who awaits the answer. */
    const [question, setQuestion] = useState<Question | null>(null);
    const answering = useRef<((ok: boolean) => void) | null>(null);
    const [runsCollapsed, setRunsCollapsed] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Edits made since the last write. Only visible when auto-save is off. */
    const [dirty, setDirty] = useState(false);
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

    // Live updates. An open run stays open and keeps filling in; otherwise the
    // newest becomes the one on screen, so a flow shows its work without a click.
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
    /** What a save writes, wherever the request came from — button, key or timer. */
    const latestFlow = useRef<Flow | null>(null);
    useEffect(() => {
        latestFlow.current = flow;
    }, [flow]);

    const autoSave = settings?.autoSaveFlows ?? true;
    /** With auto-save on the debounce covers it, so the button stays quiet. */
    const unsaved = dirty && !autoSave;

    // Main asks before closing the window over edits no file has yet.
    useEffect(() => {
        void window.api.flows.setUnsaved(unsaved);
    }, [unsaved]);

    const writeFlow = useCallback((next: Flow) => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = null;
        setDirty(false);
        void window.api.flows.save(next).catch((e: Error) => {
            setError(e.message);
            setDirty(true);
        });
    }, []);

    const saveNow = useCallback(() => {
        if (latestFlow.current) writeFlow(latestFlow.current);
    }, [writeFlow]);

    const updateFlow = useCallback(
        (next: Flow) => {
            setFlow(next);
            setFlows((prev) => prev.map((f) => (f.id === next.id ? next : f)));
            setDirty(true);
            if (!autoSave) return;
            // Debounced: dragging fires a change per frame, and each save is a file write.
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => writeFlow(next), 400);
        },
        [autoSave, writeFlow],
    );

    // Ctrl/Cmd+S saves whether or not auto-save is on — the habit costs nothing
    // when the answer is "already saved".
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent): void => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                saveNow();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [saveNow]);

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
     * Anything about to replace the flow on screen asks here first. Returns the
     * list to pick the next flow from — reread from disk when the user chose to
     * throw unsaved edits away, since the copy in memory still holds them — or
     * null if they would rather stay where they are.
     */
    const leaveFlow = async (): Promise<Flow[] | null> => {
        if (!dirty) return flows;
        // A pending debounce belongs to the flow being left, so flush it now.
        if (autoSave) {
            saveNow();
            return flows;
        }
        const discard = await ask({
            title: 'Unsaved changes',
            message: `“${flow?.name ?? 'This flow'}” has unsaved changes. Discard them?`,
            confirmLabel: 'Discard',
        });
        if (!discard) return null;
        const fresh = await window.api.flows.list();
        setFlows(fresh);
        setDirty(false);
        return fresh;
    };

    const selectFlow = async (id: string): Promise<void> => {
        if (id === flow?.id) return;
        const list = await leaveFlow();
        const next = list?.find((f) => f.id === id);
        if (!next) return;
        setFlow(next);
        setSelectedNodeId(null);
    };

    const newFlow = async (name: string): Promise<void> => {
        if (!(await leaveFlow())) return;
        const created = await window.api.flows.create(name);
        setFlows((prev) => [...prev, created]);
        setFlow(created);
        setSelectedNodeId(null);
    };

    /** The name is part of the flow, so a rename follows the auto-save setting. */
    const renameFlow = (name: string): void => {
        if (!flow || name === flow.name) return;
        updateFlow({ ...flow, name });
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
        // A queued auto-save belongs to the flow being deleted; left to fire, it
        // would write the file straight back.
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = null;
        try {
            await window.api.flows.remove(flow.id);
            const list = await window.api.flows.list();
            setFlows(list);
            setFlow(list[0] ?? null);
            setSelectedNodeId(null);
            setDirty(false);
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
            // The file joins the library either way; only the switch to it waits on
            // an answer about the edits already on screen.
            const list = await leaveFlow();
            setFlows((prev) => [...(list ?? prev).filter((f) => f.id !== imported.id), imported]);
            if (!list) return;
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

    return (
        <div className="app">
            <div className="topbar">
                <span className="brand">
                    <span className="name">Patchbay</span>
                    <span className="by">
                        by <b>Dawnlit</b>
                    </span>
                </span>

                <select value={flow.id} onChange={(e) => void selectFlow(e.target.value)}>
                    {flows.map((f) => (
                        <option key={f.id} value={f.id}>
                            {f.name}
                        </option>
                    ))}
                </select>
                <button className="ghost" title="Rename this flow" onClick={() => setNaming('rename')}>
                    ✎ Rename
                </button>
                <button className="danger" title="Delete this flow" onClick={() => void deleteFlow()}>
                    Delete
                </button>
                <button onClick={() => setNaming('new')}>New flow</button>
                <button title="Open a flow file and add it to the library" onClick={() => void loadFlow()}>
                    Load…
                </button>
                <button
                    className={unsaved ? 'primary' : ''}
                    disabled={!unsaved}
                    title={
                        autoSave
                            ? 'Edits save themselves — turn that off in Settings to save by hand.'
                            : 'Save this flow (Ctrl+S)'
                    }
                    onClick={saveNow}
                >
                    {unsaved ? 'Save' : 'Saved'}
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
                    {watching ? `Watching ${status?.watching.length ?? 0} flow(s)` : 'Not watching'}
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
                        {tab === 'skills' && <SkillLibrary skills={skills} onRefresh={refreshSkills}/>}
                        {tab === 'settings' && (
                            <SettingsPanel
                                settings={settings}
                                about={about}
                                onSave={(next) => {
                                    void window.api.settings.save(next).then((saved) => {
                                        setSettings(saved);
                                        // Switching auto-save on adopts the draft on screen.
                                        if (saved.autoSaveFlows && dirty) saveNow();
                                    });
                                }}
                            />
                        )}
                    </div>
                </div>
            </div>

            {naming && (
                <NameDialog
                    title={naming === 'new' ? 'New flow' : 'Rename flow'}
                    label="Flow name"
                    initial={naming === 'new' ? 'New flow' : flow.name}
                    confirmLabel={naming === 'new' ? 'Create' : 'Rename'}
                    onCancel={() => setNaming(null)}
                    onConfirm={(name) => {
                        setNaming(null);
                        if (naming === 'new') void newFlow(name);
                        else renameFlow(name);
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
