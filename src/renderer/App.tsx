import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    checkSlots,
    type Flow,
    type FlowNode,
    type JsonSchema,
    NODE_KIND_META,
    NODE_KINDS,
    type Schemas,
    schemaUsers,
    triggerConfig,
} from '@shared/flow';
import type { SchemaSummary } from '@shared/ipc';
import { type EmailEnvelope, type Run, type RunSummary, toSummary } from '@shared/trace';
import type { LogEntry } from '@shared/log';
import type { EngineStatus, SkillSummary } from '@shared/settings';
import { ConfirmDialog, type Question } from './components/ConfirmDialog';
import { ConsolePanel, type ConsoleView, DEFAULT_CONSOLE_VIEW } from './components/ConsolePanel';
import { type CanvasHighlight, FlowCanvas, NODE_DRAG_TYPE } from './components/FlowCanvas';
import { Inspector, type SchemaShelf } from './components/Inspector';
import { RenameFlowDialog } from './components/RenameFlowDialog';
import { RunsPanel } from './components/RunsPanel';
import { SettingsButton } from './components/SettingsButton';
import type { Library } from './components/SkillLibrary';
import { TestRunDialog } from './components/TestRunDialog';
import { WindowControls } from './components/WindowControls';
import { useErrorBanner } from './errorBanner';
import { dataTokens } from './slotColors';
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

interface Props {
    /** The flow this window was opened for. Another arrives on `on.openFlow`. */
    initialFlowId: string;
}

export function App({initialFlowId}: Props): JSX.Element {
    const [flow, setFlow] = useState<Flow | null>(null);
    /** The open flow's file, for the rename dialog and the topbar's tooltip. */
    const [file, setFile] = useState<string | null>(null);
    /** What the open workspace is called, for the skill list. */
    const [workspaceName, setWorkspaceName] = useState('');
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [skills, setSkills] = useState<SkillSummary[]>([]);
    /** The workspace's named schemas, shared by every flow in it. */
    const [schemaList, setSchemaList] = useState<SchemaSummary[]>([]);
    /** The workspace's other flows, for saying which of them an edit to a named schema reaches. */
    const [others, setOthers] = useState<Flow[]>([]);
    const [runs, setRuns] = useState<RunSummary[]>([]);
    const [selectedRun, setSelectedRun] = useState<Run | null>(null);
    const [status, setStatus] = useState<EngineStatus | null>(null);
    const [testing, setTesting] = useState(false);
    /** Open while the flow is being renamed. */
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
    const {error, attempt, report: setError} = useErrorBanner();
    const [theme, setTheme] = useTheme();

    const flowId = flow?.id ?? null;
    /** The workspace's, shared by every flow in it. */
    const refreshSkills = useCallback(async () => {
        setSkills(await window.api.skills.list());
    }, []);

    /** Edits to a named schema not written to its file yet, by name. */
    const pendingSchemas = useRef(new Map<string, JsonSchema>());
    const schemaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /** The workspace's too. An edit not written yet stays on screen over what the file holds. */
    const refreshSchemas = useCallback(async () => {
        const list = await window.api.schemas.list();
        const pending = pendingSchemas.current;
        setSchemaList(list.map((s) => (pending.has(s.name) ? {
            ...s,
            schema: pending.get(s.name)!,
            problem: undefined
        } : s)));
    }, []);

    useEffect(() => {
        void refreshSkills();
        void refreshSchemas();
    }, [refreshSkills, refreshSchemas]);
    // Main watches the skills and schemas folders and says when they change; this
    // catches one it could not watch, such as a folder made since.
    useEffect(() => {
        const refresh = (): void => {
            void refreshSkills();
            void refreshSchemas();
        };
        window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
    }, [refreshSkills, refreshSchemas]);

    const refreshRuns = useCallback(() => {
        void window.api.runs.list(100).then(setRuns);
    }, []);

    /** Read a flow and its directory. If it has been deleted, swap this window for the start page. */
    const readFlow = useCallback(async (wantedId: string) => {
        const entries = await window.api.flows.entries();
        const found = entries.find((entry) => entry.flow.id === wantedId);
        if (!found) {
            await window.api.window.showWelcome();
            void window.api.window.close();
            return;
        }
        setFlow(found.flow);
        setFile(found.file);
        setOthers(entries.flatMap((entry) => (entry.flow.id === wantedId ? [] : [entry.flow])));
    }, []);

    // ── Boot ───────────────────────────────────────────────────────────────

    useEffect(() => {
        void (async () => {
            setStatus(await window.api.engine.status());
            void window.api.workspace.current().then((open) => setWorkspaceName(open?.name ?? ''));
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
    // A run already listed keeps its row: two under way at once would otherwise
    // swap places with every update.
    useEffect(() => {
        const offRun = window.api.on.runUpdated((run) => {
            const summary = toSummary(run);
            setRuns((prev) =>
                prev.some((r) => r.id === run.id)
                    ? prev.map((r) => (r.id === run.id ? summary : r))
                    : [summary, ...prev],
            );
            setSelectedRun((current) => (!current || current.id === run.id ? run : current));
        });
        const offStatus = window.api.on.engineStatus((next) => setStatus(next));
        return () => {
            offRun();
            offStatus();
        };
    }, []);

    // ── Flow editing ───────────────────────────────────────────────────────

    // Every edit saves itself; there is no unsaved state to ask about.
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

    /** Write every edit to a named schema still waiting, now. */
    const flushSchemas = useCallback(() => {
        if (schemaTimer.current) clearTimeout(schemaTimer.current);
        schemaTimer.current = null;
        const pending = [...pendingSchemas.current];
        pendingSchemas.current.clear();
        for (const [name, schema] of pending) {
            void window.api.schemas.save(name, schema).catch((e: Error) => setError(e.message));
        }
    }, [setError]);

    /** Write queued edits — the flow's, and any to a named schema — now, rather than when their timers say so. */
    const flushSave = useCallback(() => {
        if (queued.current) writeFlow(queued.current);
        flushSchemas();
    }, [writeFlow, flushSchemas]);

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
                if (change.skills) void refreshSkills();
                if (change.schemas) void refreshSchemas();
                if (!change.flows || !flowId) return;
                flushSave();
                void readFlow(flowId);
            }),
        [flowId, flushSave, readFlow, refreshSkills, refreshSchemas],
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

    /** The named schemas a node can pick, by name. */
    const schemas: Schemas = useMemo(
        () => Object.fromEntries(schemaList.flatMap((s) => (s.schema ? [[s.name, s.schema]] : []))),
        [schemaList],
    );

    /** Shown at once, and written once typing pauses, as the flow's own edits are. */
    const saveSchema = useCallback(
        (name: string, schema: JsonSchema) => {
            pendingSchemas.current.set(name, schema);
            setSchemaList((list) => list.map((s) => (s.name === name ? {...s, schema, problem: undefined} : s)));
            if (schemaTimer.current) clearTimeout(schemaTimer.current);
            schemaTimer.current = setTimeout(flushSchemas, 400);
        },
        [flushSchemas],
    );

    /** Which slots reach each node, and what falls short — redrawn with every edit. */
    const slots = useMemo(() => (flow ? checkSlots(flow, schemas) : null), [flow, schemas]);
    /** Each slot's colour, shared by the canvas and the inspector. */
    const tokens = useMemo(() => dataTokens(flow?.nodes ?? []), [flow]);

    const updateNode = useCallback(
        (node: FlowNode) => {
            if (!flow) return;
            updateFlow({...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? node : n))});
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
            current: selectedRun.current,
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
     * Queued edits go out first.
     */
    const renameFlow = (name: string, fileName: string | null): Promise<void> =>
        attempt(async () => {
            if (!flow) return;
            flushSave();
            if (name !== flow.name) setFlow(await window.api.flows.rename(flow.id, name));
            if (fileName !== null) setFile((await window.api.flows.setFileName(flow.id, fileName)).file);
        });

    /** Whether `act` went through. When it did not, the banner says why. */
    const succeeded = async (act: () => Promise<unknown>): Promise<boolean> => {
        let ok = false;
        await attempt(async () => {
            await act();
            ok = true;
        });
        return ok;
    };

    /**
     * Renaming or deleting a named schema rewrites every flow that names it, this
     * one perhaps among them. This window's own edits go out first, and it reads the
     * flow and the schemas again after.
     */
    const rewriteSchemas = async (act: () => Promise<void>): Promise<boolean> => {
        if (!flow) return false;
        flushSave();
        const ok = await succeeded(act);
        await Promise.all([refreshSchemas(), readFlow(flow.id)]);
        return ok;
    };

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

    /** A run's email through its flow again, from its trigger. Queued edits go out first, as for a test run. */
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
    const library: Library = {workspaceName, skills, onRefresh: refreshSkills};
    const shelf: SchemaShelf = {
        schemas,
        users: (name) => ({
            here: schemaUsers(flow, schemas, name).length,
            elsewhere: others.filter((other) => schemaUsers(other, schemas, name).length > 0).map((other) => other.name),
        }),
        save: saveSchema,
        create: (name, schema) =>
            succeeded(async () => {
                const made = await window.api.schemas.create(name, schema);
                // Listed at once, so the node about to pick it never names one the canvas lacks.
                setSchemaList((list) =>
                    [...list.filter((s) => s.name !== made.name), made].toSorted((a, b) => a.name.localeCompare(b.name)),
                );
            }),
        rename: (from, to) => rewriteSchemas(() => window.api.schemas.rename(from, to)),
        remove: (name) => rewriteSchemas(() => window.api.schemas.remove(name)),
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
                    title={file ? `Rename this flow · ${file}` : 'Rename this flow'}
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
                        tokens={tokens}
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
                        <Inspector
                            node={selectedNode}
                            library={library}
                            available={selectedNode ? slots?.available.get(selectedNode.id) : undefined}
                            issues={slots?.issues.filter((issue) => issue.nodeId === selectedNode?.id) ?? []}
                            tokens={tokens}
                            onChange={updateNode}
                            shelf={shelf}
                            onDelete={deleteNode}
                        />
                    </div>
                </div>
            </div>

            {renaming && (
                <RenameFlowDialog
                    name={flow.name}
                    file={file ?? ''}
                    onCancel={() => setRenaming(false)}
                    onConfirm={(result) => {
                        setRenaming(false);
                        void renameFlow(result.name, result.fileName);
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
