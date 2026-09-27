import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    checkSlots,
    type Flow,
    type FlowNode,
    NODE_KIND_META,
    NODE_KINDS,
    retickSkill,
    triggerConfig,
} from '@shared/flow';
import { type EmailEnvelope, type Run, type RunSummary, toSummary } from '@shared/trace';
import type { LogEntry } from '@shared/log';
import { type EngineStatus, skillRef, type SkillScope, type SkillSummary } from '@shared/settings';
import { ConfirmDialog, type Question } from './components/ConfirmDialog';
import { ConsolePanel, type ConsoleView, DEFAULT_CONSOLE_VIEW } from './components/ConsolePanel';
import { type CanvasHighlight, FlowCanvas, NODE_DRAG_TYPE } from './components/FlowCanvas';
import { Inspector } from './components/Inspector';
import { RenameFlowDialog } from './components/RenameFlowDialog';
import { RunsPanel } from './components/RunsPanel';
import { SettingsButton } from './components/SettingsButton';
import { type Library, type SkillEdit, SkillEditor } from './components/SkillLibrary';
import { TestRunDialog } from './components/TestRunDialog';
import { WindowControls } from './components/WindowControls';
import { useErrorBanner } from './errorBanner';
import { useTheme } from './theme';


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
    /** Only for the skill list, which says what moving one would mean elsewhere. */
    const [flowCount, setFlowCount] = useState(1);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [skills, setSkills] = useState<SkillSummary[]>([]);
    const [runs, setRuns] = useState<RunSummary[]>([]);
    const [selectedRun, setSelectedRun] = useState<Run | null>(null);
    const [status, setStatus] = useState<EngineStatus | null>(null);
    /**
     * The skill the side panel is editing in place of the node, if any. `tickOn` is
     * the node a new one was written from, which ticks it once it is saved.
     */
    const [editingSkill, setEditingSkill] = useState<(SkillEdit & { tickOn: string | null }) | null>(null);
    const [testing, setTesting] = useState(false);
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
    // The global library's folders are edited in other apps too; coming back is when to look again.
    useEffect(() => {
        window.addEventListener('focus', refreshSkills);
        return () => window.removeEventListener('focus', refreshSkills);
    }, [refreshSkills]);

    const refreshRuns = useCallback(() => {
        void window.api.runs.list(100).then(setRuns);
    }, []);

    /** Read a flow and its directory. If it has been deleted, swap this window for the start page. */
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
     * Main refuses a save made before someone else wrote the flow. Then the edit
     * is dropped with a message, and the canvas shows the flow as it now stands
     * (or closes if it was deleted).
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

    /** Flush on blur, so another window reading this flow off disk sees what is on the canvas. */
    useEffect(() => {
        window.addEventListener('blur', flushSave);
        return () => window.removeEventListener('blur', flushSave);
    }, [flushSave]);

    /**
     * Another writer (an agent, the welcome window) changed the workspace. Flush
     * our queued edit first, which is refused if they wrote this flow, then re-read.
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
                setEditingSkill(null);
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

    /** Which slots reach each node, and what falls short — redrawn with every edit. */
    const slots = useMemo(() => (flow ? checkSlots(flow) : null), [flow]);

    const updateNode = useCallback(
        (node: FlowNode) => {
            if (!flow) return;
            updateFlow({ ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? node : n)) });
        },
        [flow, updateFlow],
    );

    /** A skill that moved library changed name (`global:x` ↔ `x`); re-point this flow's nodes. */
    const relabelSkill = useCallback(
        (from: SkillScope, to: SkillScope, name: string) => {
            if (!flow) return;
            const next = retickSkill(flow, skillRef(from, name), skillRef(to, name));
            if (next !== flow) updateFlow(next);
        },
        [flow, updateFlow],
    );

    /** Back from the skill editor, ticking a new skill on the node it was written from. */
    const closeSkill = (saved: boolean): void => {
        setEditingSkill(null);
        const node = flow?.nodes.find((n) => n.id === editingSkill?.tickOn);
        if (!saved || !editingSkill || !node) return;
        const { config } = node;
        const ref = skillRef(editingSkill.scope, editingSkill.name);
        if ((config.kind !== 'processor' && config.kind !== 'extractor') || config.skills.includes(ref)) return;
        updateNode({ ...node, config: { ...config, skills: [...config.skills, ref] } });
    };

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

    /** `window.confirm` via ConfirmDialog; Electron's native box leaves the page unable to take focus. */
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

    /** This flow only. Queued edits go out first: the watcher reads the flow off disk. */
    const toggleWatching = (): Promise<void> =>
        attempt(async () => {
            if (!flow) return;
            flushSave();
            const on = status?.flowIds.includes(flow.id) === true;
            setStatus(await (on ? window.api.engine.stop(flow.id) : window.api.engine.start(flow.id)));
        });

    /**
     * Through main rather than a canvas save, so the welcome window hears of it.
     * Queued edits go out first. The folder move is refused while a run uses it.
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
            setError('That run is no longer stored — it was deleted after it was logged.');
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

    const removeRun = async (id: string): Promise<void> => {
        const subject = runs.find((r) => r.id === id)?.subject || '(no subject)';
        const ok = await ask({
            title: 'Delete run',
            message: `Delete the run of “${subject}”? Its trace and saved files go too.`,
            confirmLabel: 'Delete',
        });
        if (!ok) return;
        await attempt(async () => {
            await window.api.runs.remove(id);
            setRuns((prev) => prev.filter((r) => r.id !== id));
            setSelectedRun((current) => (current?.id === id ? null : current));
        });
    };

    /**
     * Test one email from the named trigger. Queued edits go out first, since the
     * engine reads the flow from disk.
     */
    const runEmail = (nodeId: string, email: EmailEnvelope): void => {
        if (!flow) return;
        flushSave();
        setSelectedRun(null);
        showDock('runs');
        void window.api.engine.testRun(flow.id, nodeId, email).catch((e: Error) => setError(e.message));
    };

    /**
     * A run's email through its flow again, from the trigger it came in by. Queued
     * edits go out first, as for a test run: the new run reads the flow as it is now.
     */
    const rerun = (runId: string): void => {
        flushSave();
        setSelectedRun(null);
        void window.api.runs.rerun(runId).catch((e: Error) => setError(e.message));
    };

    /**
     * An email taken from Outlook — dragged out of it, or selected in it: found in
     * the trigger's mailbox first, then run like any other.
     */
    const runFromOutlook = (nodeId: string, take: (account: string) => Promise<EmailEnvelope>): void => {
        const trigger = flow?.nodes.find((n) => n.id === nodeId);
        const account = triggerConfig(trigger)?.account ?? '';
        if (!account) {
            setError(`Choose a mailbox on “${trigger?.name ?? 'the trigger'}” first — the email is looked for there.`);
            return;
        }
        void take(account).then(
            (email) => runEmail(nodeId, email),
            (e: Error) => setError(e.message),
        );
    };

    if (!flow) {
        return <div className="empty loading">Loading…</div>;
    }

    const watching = status?.flowIds.includes(flow.id) === true;
    const mailboxes = status?.watching.filter((w) => w.flowId === flow.id).length ?? 0;
    const library: Library = {
        flowId: flow.id,
        flowName: flow.name,
        skills,
        otherFlowCount: flowCount - 1,
        onRefresh: refreshSkills,
        onMoved: relabelSkill,
        onEdit: (edit) => setEditingSkill({ ...edit, tickOn: edit.template === undefined ? null : selectedNodeId }),
    };

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
                    {watching ? `Watching ${mailboxes} mailbox(es)` : 'Not watching'}
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
                    {NODE_KINDS.map((kind) => {
                        const meta = NODE_KIND_META[kind];
                        return (
                            <div
                                key={kind}
                                className={`palette-item kind-${meta.token}`}
                                draggable
                                onDragStart={(e) => {
                                    e.dataTransfer.setData(NODE_DRAG_TYPE, kind);
                                    e.dataTransfer.effectAllowed = 'move';
                                }}
                            >
                                <strong>{meta.label}</strong>
                                <span>{meta.blurb}</span>
                            </div>
                        );
                    })}
                </div>

                <div className="center">
                    <FlowCanvas
                        flow={flow}
                        selectedNodeId={selectedNodeId}
                        highlight={highlight}
                        slots={slots}
                        onChange={updateFlow}
                        onSelect={setSelectedNodeId}
                        onRunOutlookDrag={(nodeId, drag) =>
                            runFromOutlook(nodeId, (account) => window.api.outlook.dragged(account, drag))
                        }
                        onRunOutlookSelected={(nodeId) => runFromOutlook(nodeId, window.api.outlook.selected)}
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
                                onRemove={(runId) => void removeRun(runId)}
                                onRerun={rerun}
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
                    <div className="side-body">
                        {editingSkill ? (
                            <SkillEditor
                                key={skillRef(editingSkill.scope, editingSkill.name)}
                                edit={editingSkill}
                                flowId={flow.id}
                                flowName={flow.name}
                                skills={skills}
                                onRefresh={refreshSkills}
                                onClose={closeSkill}
                            />
                        ) : (
                            <Inspector
                                node={selectedNode}
                                library={library}
                                available={selectedNode ? slots?.available.get(selectedNode.id) : undefined}
                                issues={slots?.issues.filter((issue) => issue.nodeId === selectedNode?.id) ?? []}
                                onChange={updateNode}
                                onDelete={deleteNode}
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
