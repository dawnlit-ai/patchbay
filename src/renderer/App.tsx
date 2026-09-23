import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Flow, type FlowNode, NODE_KIND_META, type NodeKind, retickSkill } from '@shared/flow';
import { type EmailEnvelope, type Run, type RunSummary, toSummary } from '@shared/trace';
import type { LogEntry } from '@shared/log';
import { type EngineStatus, skillRef, type SkillScope, type SkillSummary } from '@shared/settings';
import { ConfirmDialog, type Question } from './components/ConfirmDialog';
import { ConsolePanel, type ConsoleView, DEFAULT_CONSOLE_VIEW } from './components/ConsolePanel';
import { type CanvasHighlight, FlowCanvas } from './components/FlowCanvas';
import { Inspector } from './components/Inspector';
import { MailList } from './components/MailList';
import { RenameFlowDialog } from './components/RenameFlowDialog';
import { RunsPanel } from './components/RunsPanel';
import { SettingsButton } from './components/SettingsButton';
import { SkillLibrary } from './components/SkillLibrary';
import { TestRunDialog } from './components/TestRunDialog';
import { WindowControls } from './components/WindowControls';
import { useErrorBanner } from './errorBanner';
import { useTheme } from './theme';

const PALETTE: NodeKind[] = ['trigger.outlook', 'categorizer', 'processor', 'terminal'];

/** Matches what main keeps, so the window never holds lines main has let go. */
const LOG_LIMIT = 2_000;

/**
 * Entries in `seq` order, each once. A push normally lands past the end; only the
 * list fetched at boot can overlap pushes that arrived while it was on its way.
 */
function mergeLog(current: LogEntry[], incoming: LogEntry[]): LogEntry[] {
    const last = current.at(-1)?.seq ?? 0;
    const merged = incoming.every((e) => e.seq > last)
        ? [...current, ...incoming]
        : [...new Map([...current, ...incoming].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
    return merged.length > LOG_LIMIT ? merged.slice(-LOG_LIMIT) : merged;
}

const isProblem = (entry: LogEntry): boolean => entry.level === 'warn' || entry.level === 'error';

/** Where the open flow is kept, for the rename dialog and the topbar's tooltip. */
interface Place {
    folder: string;
    path: string;
}

interface Props {
    /** The flow this window was opened for. Another arrives on `on.openFlow`. */
    initialFlowId: string;
}

export function App({ initialFlowId }: Props): JSX.Element {
    const [flow, setFlow] = useState<Flow | null>(null);
    const [place, setPlace] = useState<Place | null>(null);
    /** Only for the Skills tab, which says what moving one would mean elsewhere. */
    const [flowCount, setFlowCount] = useState(1);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [skills, setSkills] = useState<SkillSummary[]>([]);
    const [runs, setRuns] = useState<RunSummary[]>([]);
    const [selectedRun, setSelectedRun] = useState<Run | null>(null);
    const [status, setStatus] = useState<EngineStatus | null>(null);
    const [tab, setTab] = useState<'inspector' | 'skills'>('inspector');
    const [testing, setTesting] = useState(false);
    /** An email is being dragged out of the mail list toward a trigger. */
    const [emailDrag, setEmailDrag] = useState(false);
    /** Open while the flow's name — and possibly its folder — is being changed. */
    const [renaming, setRenaming] = useState(false);
    /** The question ConfirmDialog is showing, if any, and who awaits the answer. */
    const [question, setQuestion] = useState<Question | null>(null);
    const answering = useRef<((ok: boolean) => void) | null>(null);
    const [dockCollapsed, setDockCollapsed] = useState(false);
    const [dockTab, setDockTab] = useState<'runs' | 'console'>('runs');
    const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
    const [consoleView, setConsoleView] = useState<ConsoleView>(DEFAULT_CONSOLE_VIEW);
    /** Warnings and errors logged since the console was last on screen. */
    const [unseenProblems, setUnseenProblems] = useState(0);
    /** Read by the push listener, which is subscribed once and would see stale state. */
    const consoleOnScreen = useRef(false);
    consoleOnScreen.current = dockTab === 'console' && !dockCollapsed;
    const { error, attempt, report: setError } = useErrorBanner();
    const [theme, setTheme] = useTheme();

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

    /**
     * Read one flow out of the workspace, with the directory it sits in. A flow
     * that is not there any more was deleted from the welcome window or by an
     * agent, and this window has nothing left to show: the start page comes back
     * and takes its place.
     */
    const readFlow = useCallback(async (wantedId: string) => {
        const entries = await window.api.flows.entries();
        setFlowCount(entries.length);
        const found = entries.find((entry) => entry.flow.id === wantedId);
        if (!found) {
            await window.api.window.showWelcome();
            void window.api.window.close();
            return;
        }
        setFlow(found.flow);
        setPlace({ folder: found.folder, path: found.path });
    }, []);

    // ── Boot ───────────────────────────────────────────────────────────────

    useEffect(() => {
        void (async () => {
            setStatus(await window.api.engine.status());
            await readFlow(initialFlowId);
            refreshRuns();
        })();
    }, [initialFlowId, readFlow, refreshRuns]);

    // Subscribed before the list is asked for, so nothing logged in between is lost;
    // mergeLog drops whatever arrives both ways.
    useEffect(() => {
        const off = window.api.on.logged((entry) => {
            setLogEntries((prev) => mergeLog(prev, [entry]));
            if (isProblem(entry) && !consoleOnScreen.current) setUnseenProblems((n) => n + 1);
        });
        void window.api.log.list().then((listed) => {
            setLogEntries((prev) => mergeLog(prev, listed));
            // What went wrong before the window opened — a port already taken — counts too.
            if (!consoleOnScreen.current) setUnseenProblems(listed.filter(isProblem).length);
        });
        return off;
    }, []);

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

    // Every edit is written for you. There is no draft state to lose, so nothing
    // asks about unsaved changes and nothing has to be pressed to keep work.
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** The flow a queued write would put on disk, or null once one has. */
    const queued = useRef<Flow | null>(null);
    /** Read by a save's reply, which may arrive after this window moved on. */
    const shownId = useRef<string | null>(null);
    shownId.current = flow?.id ?? null;

    /**
     * Every save names the version the canvas last read, in `updatedAt`, and main
     * refuses one made before somebody else wrote the flow — an agent, or the
     * start window. Writing it anyway would undo their change without either side
     * knowing. So the refusal is said out loud, the edit is let go, and the canvas
     * takes up the flow as it now stands, or closes if it was deleted.
     */
    const writeFlow = useCallback(
        (next: Flow) => {
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = null;
            queued.current = null;
            void window.api.flows.save(next).then(
                (outcome) => {
                    if ('saved' in outcome) return;
                    // An edit queued since was made to the same overtaken version.
                    if (queued.current?.id === next.id && queued.current.updatedAt === next.updatedAt) {
                        if (saveTimer.current) clearTimeout(saveTimer.current);
                        saveTimer.current = null;
                        queued.current = null;
                    }
                    setError(
                        'This flow was changed somewhere else — by an agent, or in another window — after your last edit was made, so that edit was not saved. The canvas now shows the flow as it stands.',
                    );
                    if (shownId.current === next.id) void readFlow(next.id);
                },
                (e: Error) => {
                    setError(e.message);
                    // Left queued unless a newer edit already took its place, so the next
                    // write — or leaving the flow — tries again.
                    queued.current ??= next;
                },
            );
        },
        [readFlow, setError],
    );

    /** Write a queued edit now, rather than when its timer says so. */
    const flushSave = useCallback(() => {
        if (queued.current) writeFlow(queued.current);
    }, [writeFlow]);

    /**
     * The welcome window lists this flow while it is open here, and can rename or
     * copy it from that list. So the debounce does not outlive this window losing
     * focus: by the time another window is being clicked in, what it reads off
     * disk is what is on the canvas.
     */
    useEffect(() => {
        window.addEventListener('blur', flushSave);
        return () => window.removeEventListener('blur', flushSave);
    }, [flushSave]);

    /**
     * An agent driving the app through its MCP server writes to the same files
     * this window does, and so does the welcome window — the moment either does,
     * what is on screen is behind. An edit of ours still in the queue goes out
     * first — refused, and said so, if that write was to this flow; then the flow
     * on screen becomes whatever the store now holds under its id.
     */
    useEffect(
        () =>
            window.api.on.workspaceChanged((change) => {
                if (change.skills) refreshSkills();
                if (!change.flows || !flowId) return;
                flushSave();
                void readFlow(flowId);
            }),
        [flowId, flushSave, readFlow, refreshSkills],
    );

    /** The welcome window picked another flow, and this is the window to show it. */
    useEffect(
        () =>
            window.api.on.openFlow((nextId) => {
                if (nextId === flowId) return;
                // The hash is what this window was opened with and what a reload reads,
                // so it follows the flow rather than naming the one it started on.
                history.replaceState(null, '', `#flow=${encodeURIComponent(nextId)}`);
                flushSave();
                setSelectedNodeId(null);
                setSelectedRun(null);
                void readFlow(nextId);
            }),
        [flowId, flushSave, readFlow],
    );

    const updateFlow = useCallback(
        (next: Flow) => {
            setFlow(next);
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
            const next = retickSkill(flow, skillRef(from, name), skillRef(to, name));
            if (next !== flow) updateFlow(next);
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
     * a `select` refuses to open until another window has had focus.
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

    const toggleWatching = (): Promise<void> =>
        attempt(async () => {
            setStatus(status?.running ? await window.api.engine.stop() : await window.api.engine.start());
        });

    /**
     * Both halves go through main rather than through the canvas's own save: the
     * welcome window may be listing this flow while it is renamed, and it is told
     * about these. Any edit still in the queue goes out first, so the rename lands
     * on the graph as it stands here. Moving the folder is the half that can be
     * refused — while a run is using it as a working directory, it says so.
     */
    const renameFlow = (name: string, folder: string | null): Promise<void> =>
        attempt(async () => {
            if (!flow) return;
            flushSave();
            if (name !== flow.name) setFlow(await window.api.flows.rename(flow.id, name));
            if (folder !== null && folder !== place?.folder) {
                const moved = await window.api.flows.setFolder(flow.id, folder);
                setPlace({ folder: moved.folder, path: moved.path });
            }
        });

    /** Brings a tab of the dock up, unfolding the dock if it was folded away. */
    const showDock = (tab: 'runs' | 'console'): void => {
        setDockTab(tab);
        setDockCollapsed(false);
        if (tab === 'console') setUnseenProblems(0);
    };

    const clearLog = (): void => {
        void window.api.log.clear().then(() => setLogEntries([]));
    };

    /** A console line names the run it is about; this shows that run's trace. */
    const openRunFromLog = async (runId: string): Promise<void> => {
        const run = await window.api.runs.get(runId);
        if (!run) {
            setError('That run is no longer stored — the runs were cleared after it was logged.');
            return;
        }
        setSelectedRun(run);
        showDock('runs');
    };

    const clearRuns = async (): Promise<void> => {
        const ok = await ask({
            title: 'Clear runs',
            message: 'Delete every stored run? Their traces and saved files go too.',
            confirmLabel: 'Delete',
        });
        if (!ok) return;
        await attempt(async () => {
            await window.api.runs.clear();
            setRuns([]);
            setSelectedRun(null);
        });
    };

    /**
     * One email through the flow on screen, starting at the trigger named — picked
     * in the Test run dialog, or dropped on the canvas. The engine reads the flow
     * from disk, so a queued edit goes out first: a test straight after an edit
     * runs the flow as it now looks. The runs panel opens to follow it.
     */
    const runEmail = (nodeId: string, email: EmailEnvelope): void => {
        if (!flow) return;
        flushSave();
        setSelectedRun(null);
        showDock('runs');
        void window.api.engine.testRun(flow.id, nodeId, email).catch((e: Error) => setError(e.message));
    };

    if (!flow) {
        return <div className="empty loading">Loading…</div>;
    }

    const watching = status?.running === true;

    return (
        <div className="app">
            <div className="topbar">
                <button
                    className="ghost"
                    title="Back to your flows — the list, and everything you can do to one"
                    onClick={() => void window.api.window.showWelcome()}
                >
                    ☰ Flows
                </button>
                <button
                    className="flow-name"
                    title={place ? `Rename this flow · ${place.path}` : 'Rename this flow'}
                    onClick={() => setRenaming(true)}
                >
                    {flow.name}
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

                {status?.lastError && (
                    <span className="badge err link" title="Open the console" onClick={() => showDock('console')}>
                        {status.lastError}
                    </span>
                )}
                <span className="status-pill">
                    <span className={`dot ${watching ? 'live' : ''}`}/>
                    {watching ? `Watching ${status?.watching.length ?? 0} mailbox(es)` : 'Not watching'}
                </span>
                <button className={watching ? '' : 'primary'} onClick={() => void toggleWatching()}>
                    {watching ? 'Stop' : 'Start watching'}
                </button>

                <SettingsButton/>
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

                    <MailList flow={flow} onDragging={setEmailDrag}/>
                </div>

                <div className="center">
                    <FlowCanvas
                        flow={flow}
                        selectedNodeId={selectedNodeId}
                        highlight={highlight}
                        emailDrag={emailDrag}
                        onChange={updateFlow}
                        onSelect={setSelectedNodeId}
                        onRunEmail={runEmail}
                    />
                    <div className={`dock${dockCollapsed ? ' collapsed' : ''}`}>
                        <div className="dock-tabs">
                            <button
                                className={dockTab === 'runs' && !dockCollapsed ? 'active' : ''}
                                onClick={() => showDock('runs')}
                            >
                                Runs <span className="badge">{runs.length}</span>
                            </button>
                            <button
                                className={dockTab === 'console' && !dockCollapsed ? 'active' : ''}
                                onClick={() => showDock('console')}
                            >
                                Console
                                {unseenProblems > 0 && (
                                    <span className="badge err" title="Warnings and errors you have not seen">
                                        {unseenProblems}
                                    </span>
                                )}
                            </button>
                            <span className="spacer"/>
                            <button
                                className="ghost"
                                onClick={() => (dockCollapsed ? showDock(dockTab) : setDockCollapsed(true))}
                            >
                                {dockCollapsed ? '▴ Show' : '▾'}
                            </button>
                        </div>
                        {!dockCollapsed && dockTab === 'runs' && (
                            <RunsPanel
                                runs={runs}
                                selected={selectedRun}
                                onSelect={(id) => void window.api.runs.get(id).then(setSelectedRun)}
                                onClear={() => void clearRuns()}
                                onReveal={() => void window.api.runs.revealFolder()}
                                onCancel={(runId) => void window.api.engine.cancel(runId)}
                            />
                        )}
                        {!dockCollapsed && dockTab === 'console' && (
                            <ConsolePanel
                                entries={logEntries}
                                view={consoleView}
                                onView={setConsoleView}
                                onClear={clearLog}
                                onReveal={() => void window.api.log.revealFolder()}
                                onOpenRun={(runId) => void openRunFromLog(runId)}
                            />
                        )}
                    </div>
                </div>

                <div className="side right">
                    <div className="tabs">
                        <button className={tab === 'inspector' ? 'active' : ''} onClick={() => setTab('inspector')}>
                            Node
                        </button>
                        <button className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>
                            Skills
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
                                otherFlowCount={flowCount - 1}
                                onRefresh={refreshSkills}
                                onMoved={relabelSkill}
                            />
                        )}
                    </div>
                </div>
            </div>

            {renaming && (
                <RenameFlowDialog
                    name={flow.name}
                    folder={place?.folder ?? ''}
                    path={place?.path ?? ''}
                    onCancel={() => setRenaming(false)}
                    onConfirm={(result) => {
                        setRenaming(false);
                        void renameFlow(result.name, result.folder);
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
                        runEmail(nodeId, email);
                    }}
                />
            )}
        </div>
    );
}
