import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { findTriggers, type Flow } from '@shared/flow';
import type { FlowEntry } from '@shared/ipc';
import type { AboutInfo, EngineStatus } from '@shared/settings';
import { ConfirmDialog, type Question } from './components/ConfirmDialog';
import { ContextMenu, type MenuItem } from './components/ContextMenu';
import { NewFlowDialog } from './components/NewFlowDialog';
import { OpenWhereDialog } from './components/OpenWhereDialog';
import { RenameFlowDialog, type RenameResult } from './components/RenameFlowDialog';
import { SettingsButton } from './components/SettingsButton';
import { WindowControls } from './components/WindowControls';
import { useErrorBanner } from './errorBanner';
import { ago } from './format';
import { useTheme } from './theme';

/** The start window: every flow, where it lives, and what can be done to it without opening it. */

/** Newest work first is the useful default; by name is for finding one you know. */
type Sort = 'recent' | 'name';

type Dialog =
    | { kind: 'new' }
    /** A flow chosen while a canvas is up on another: which window it lands on. */
    | { kind: 'open'; flow: Flow; current: string }
    | { kind: 'duplicate'; entry: FlowEntry }
    | { kind: 'rename'; entry: FlowEntry }
    | { kind: 'delete'; entry: FlowEntry };

/** What the graph amounts to, for someone deciding which flow this is. */
function shape(flow: Flow): string {
    if (flow.nodes.length === 0) return 'empty';
    const triggers = findTriggers(flow).length;
    const nodes = `${flow.nodes.length} node${flow.nodes.length === 1 ? '' : 's'}`;
    return triggers === 0 ? `${nodes} · no trigger` : `${nodes} · ${triggers} trigger${triggers === 1 ? '' : 's'}`;
}

/** Why a flow's mail is not being polled, for the badge that says so. */
function notWatchedWhy(flow: Flow, status: EngineStatus | null): string {
    if (findTriggers(flow).length === 0) return 'This flow has no trigger';
    if (status?.flowIds.includes(flow.id) !== true) return 'Watching is off for this flow';
    return 'No trigger in this flow names a mailbox';
}

/** A flow opened in place is only taken off the list: its file and folder are the user's. */
function removal({flow, file, inPlace}: FlowEntry): Question {
    return inPlace
        ? {
            title: 'Remove from list',
            message: `Take “${flow.name}” off the list? Its file stays where it is, at ${file}, and so does its folder. Runs already recorded stay. Open flow file… brings it back.`,
            confirmLabel: 'Remove',
        }
        : {
            title: 'Delete flow',
            message: `Delete “${flow.name}”? Its folder goes too, with the skills only this flow has. Runs already recorded stay. This cannot be undone.`,
            confirmLabel: 'Delete',
        };
}

/**
 * A flow's path on one line, truncating the parent folders first so its own
 * folder always shows. Hovering shows the whole path in a panel below.
 */
function Where({path}: { path: string }): JSX.Element {
    // The separator stays with the kept half, so a cut path still reads as one.
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return (
        <code className="where">
            <span className="dir">{path.slice(0, Math.max(0, cut))}</span>
            <span className="base">{path.slice(Math.max(0, cut))}</span>
            {/* For the eye only: a screen reader already gets it from the halves above. */}
            <span className="full" aria-hidden="true">{path}</span>
        </code>
    );
}

export function Welcome(): JSX.Element {
    const [entries, setEntries] = useState<FlowEntry[] | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<Sort>('recent');
    const [dialog, setDialog] = useState<Dialog | null>(null);
    /** The flow a right-click landed on, and where it landed. */
    const [menu, setMenu] = useState<{ entry: FlowEntry; x: number; y: number } | null>(null);
    const [about, setAbout] = useState<AboutInfo | null>(null);
    const [status, setStatus] = useState<EngineStatus | null>(null);
    const {error, attempt} = useErrorBanner();
    const [theme, setTheme] = useTheme();
    const rows = useRef(new Map<string, HTMLDivElement>());

    const refresh = useCallback(() => {
        void window.api.flows.entries().then((list) => {
            setEntries(list);
            // Whatever was selected, unless it has just been deleted from under us.
            setSelectedId((current) => (list.some((e) => e.flow.id === current) ? current : null));
        });
    }, []);

    useEffect(() => {
        refresh();
        void window.api.about().then(setAbout);
        void window.api.engine.status().then(setStatus);
    }, [refresh]);

    useEffect(() => window.api.on.engineStatus(setStatus), []);

    // Canvases and agents write the workspace too: re-read on their changes and on focus.
    useEffect(() => {
        const off = window.api.on.workspaceChanged((change) => {
            if (change.flows) refresh();
        });
        window.addEventListener('focus', refresh);
        return () => {
            off();
            window.removeEventListener('focus', refresh);
        };
    }, [refresh]);

    const watched = new Set(status?.watching.map((w) => w.flowId));

    const needle = query.trim().toLowerCase();
    const shown = (entries ?? [])
        .filter(
            (e) =>
                needle === '' ||
                e.flow.name.toLowerCase().includes(needle) ||
                e.folder.toLowerCase().includes(needle),
        )
        .toSorted((a, b) =>
            sort === 'name'
                ? a.flow.name.localeCompare(b.flow.name)
                : b.flow.updatedAt.localeCompare(a.flow.updatedAt),
        );

    // Nothing chosen yet means the top of the list — under the default sort, the
    // flow last worked on, which is the one the window was most likely opened for.
    const selected = shown.find((e) => e.flow.id === selectedId) ?? shown[0] ?? null;

    // ── Actions ────────────────────────────────────────────────────────────

    /**
     * Open the flow on a canvas. Asks which canvas only when one is up showing a
     * different flow.
     */
    const open = async (flow: Flow): Promise<void> => {
        const canvases = await window.api.window.openFlows();
        const current = canvases[0];
        if (current === undefined || canvases.includes(flow.id)) {
            await window.api.window.openFlow(flow.id);
            return;
        }
        setDialog({
            kind: 'open',
            flow,
            // The list is re-read whenever this window is looked at, so the flow on
            // that canvas is in it; a flow deleted from under us is the exception.
            current: entries?.find((e) => e.flow.id === current)?.flow.name ?? 'Another flow',
        });
    };

    /** A flow you just made is one you meant to draw, so it opens on the canvas. */
    const create = (name: string, location: string): Promise<void> =>
        attempt(async () => {
            const made = await window.api.flows.create(name, location);
            refresh();
            await open(made);
        });

    const duplicate = (entry: FlowEntry, name: string, location: string): Promise<void> =>
        attempt(async () => {
            const copy = await window.api.flows.duplicate(entry.flow, name, location);
            refresh();
            setSelectedId(copy.id);
        });

    const rename = (entry: FlowEntry, result: RenameResult): Promise<void> =>
        attempt(async () => {
            try {
                if (result.name !== entry.flow.name) {
                    await window.api.flows.rename(entry.flow.id, result.name);
                }
                // Second, and separately: moving the folder is the half that can be
                // refused, and by then the rename it was keeping up with has landed.
                if (result.folder !== null) await window.api.flows.setFolder(entry.flow.id, result.folder);
            } finally {
                // Either way the list now shows whichever half of it went through.
                refresh();
            }
        });

    const remove = (entry: FlowEntry): Promise<void> =>
        attempt(async () => {
            await window.api.flows.remove(entry.flow.id);
            refresh();
        });

    const setWatching = (flowId: string, on: boolean): Promise<void> =>
        attempt(async () => {
            setStatus(await (on ? window.api.engine.start(flowId) : window.api.engine.stop(flowId)));
        });

    const openFile = (): Promise<void> =>
        attempt(async () => {
            const opened = await window.api.flows.pickAndOpen();
            if (!opened) return;
            refresh();
            await open(opened);
        });

    // ── Keyboard ───────────────────────────────────────────────────────────

    const move = (from: FlowEntry, delta: number): void => {
        const at = shown.indexOf(from);
        const next = shown[Math.min(shown.length - 1, Math.max(0, at + delta))];
        if (!next || next === from) return;
        setSelectedId(next.flow.id);
        rows.current.get(next.flow.id)?.focus();
    };

    /** The actions for one flow, shown in its row's context menu. */
    const actions = (entry: FlowEntry): MenuItem[] => [
        {label: 'Open', onSelect: () => void open(entry.flow)},
        {
            label: entry.inPlace ? 'Show file in folder' : 'Open folder',
            onSelect: () => void window.api.flows.revealFolder(entry.flow.id),
        },
        status?.flowIds.includes(entry.flow.id) === true
            ? {label: 'Stop watching', separator: true, onSelect: () => void setWatching(entry.flow.id, false)}
            : {label: 'Start watching', separator: true, onSelect: () => void setWatching(entry.flow.id, true)},
        {label: 'Rename…', separator: true, onSelect: () => setDialog({kind: 'rename', entry})},
        {label: 'Duplicate…', onSelect: () => setDialog({kind: 'duplicate', entry})},
        {
            label: entry.inPlace ? 'Remove from list' : 'Delete',
            separator: true,
            danger: !entry.inPlace,
            onSelect: () => setDialog({kind: 'delete', entry}),
        },
    ];

    const nothingYet = entries !== null && entries.length === 0;

    return (
        <div className="app">
            <div className="topbar">
                {/* What the window is for, rather than what it is called. */}
                <span className="window-title">Open a flow</span>
                <span className="spacer"/>
                <SettingsButton/>
                <WindowControls maximize={false}/>
            </div>

            {error && <div className="err-banner inset">{error}</div>}

            <div className="welcome">
                <div className="welcome-rail">
                    <div className="lede">
                        <h1>Your flows</h1>
                        <p>
                            A flow is a canvas, a mailbox it watches and a folder on disk that holds its own
                            skills. Double-click one to draw it, right-click it for everything else, or start
                            something new.
                        </p>
                    </div>

                    <button className="primary wide" onClick={() => setDialog({kind: 'new'})}>
                        ＋ New flow
                    </button>
                    <button
                        className="wide"
                        title="Opens it where it is: edits are saved to that file, and its folder is where it runs"
                        onClick={() => void openFile()}
                    >
                        ↓ Open flow file…
                    </button>

                    <span className="spacer"/>

                    <div className="section-title">Workspace</div>
                    <div className="side-note">
                        Global skills, runs and logs sit under here. Flows stay wherever you keep them.
                    </div>
                    {about && <code className="path">{about.workspace}</code>}
                    <button className="wide" onClick={() => void window.api.revealWorkspace()}>
                        Open workspace folder
                    </button>

                    <div className="welcome-foot">
                        <button
                            className="ghost"
                            title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
                            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                        >
                            {theme === 'light' ? '◐ Dark' : '◑ Light'}
                        </button>
                        <span className="spacer"/>
                        {about && <span className="dim">v{about.version}</span>}
                    </div>
                </div>

                <div className="welcome-main">
                    <div className="welcome-head">
                        <strong>Flows</strong>
                        <span className="badge">{entries?.length ?? 0}</span>
                        <span className="spacer"/>
                        {!nothingYet && (
                            <>
                                <input
                                    className="compact"
                                    placeholder="Filter"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                />
                                <select
                                    className="compact"
                                    value={sort}
                                    onChange={(e) => setSort(e.target.value as Sort)}
                                    title="Order the list"
                                >
                                    <option value="recent">Last edited</option>
                                    <option value="name">Name</option>
                                </select>
                            </>
                        )}
                    </div>

                    <div className="flow-list" role="listbox" aria-label="Flows">
                        {entries === null && <div className="empty">Loading…</div>}
                        {nothingYet && (
                            <div className="empty">
                                No flows yet. <b>New flow</b> gives you a canvas and a folder of its own.
                            </div>
                        )}
                        {entries !== null && !nothingYet && shown.length === 0 && (
                            <div className="empty">Nothing matches “{query}”.</div>
                        )}
                        {shown.map((entry) => (
                            <div
                                key={entry.flow.id}
                                ref={(el) => {
                                    if (el) rows.current.set(entry.flow.id, el);
                                    else rows.current.delete(entry.flow.id);
                                }}
                                role="option"
                                aria-selected={entry === selected}
                                tabIndex={0}
                                className={`flow-row${entry === selected ? ' active' : ''}`}
                                onClick={() => setSelectedId(entry.flow.id)}
                                onDoubleClick={() => void open(entry.flow)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    setSelectedId(entry.flow.id);
                                    // The menu key and Shift+F10 have no pointer
                                    // position: open under the row's left edge.
                                    const box = e.currentTarget.getBoundingClientRect();
                                    setMenu({
                                        entry,
                                        x: e.clientX || box.left + 16,
                                        y: e.clientY || box.bottom - 6,
                                    });
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') void open(entry.flow);
                                    else if (e.key === 'ArrowDown') move(entry, 1);
                                    else if (e.key === 'ArrowUp') move(entry, -1);
                                    else return;
                                    e.preventDefault();
                                }}
                            >
                                <div className="grow">
                                    <div className="title">
                                        {entry.flow.name}
                                        {watched.has(entry.flow.id) ? (
                                            <span className="badge ok" title="A trigger in this flow is being polled">
                                                <span className="dot live"/> watching
                                            </span>
                                        ) : (
                                            <span className="badge" title={notWatchedWhy(entry.flow, status)}>
                                                <span className="dot"/> not watching
                                            </span>
                                        )}
                                    </div>
                                    <div className="meta">
                                        {shape(entry.flow)} · edited {ago(entry.flow.updatedAt)}
                                    </div>
                                </div>
                                <Where path={entry.inPlace ? entry.file : entry.path}/>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    label={menu.entry.flow.name}
                    items={actions(menu.entry)}
                    onClose={() => setMenu(null)}
                />
            )}

            {dialog?.kind === 'new' && (
                <NewFlowDialog
                    onCancel={() => setDialog(null)}
                    onConfirm={(name, location) => {
                        setDialog(null);
                        void create(name, location);
                    }}
                />
            )}

            {dialog?.kind === 'open' && (
                <OpenWhereDialog
                    name={dialog.flow.name}
                    current={dialog.current}
                    onCancel={() => setDialog(null)}
                    onChoose={(where) => {
                        const {flow} = dialog;
                        setDialog(null);
                        void window.api.window.openFlow(flow.id, where);
                    }}
                />
            )}

            {dialog?.kind === 'duplicate' && (
                <NewFlowDialog
                    title="Duplicate flow"
                    initialName={`${dialog.entry.flow.name} copy`}
                    confirmLabel="Duplicate"
                    note="The skills belonging to this flow come with it."
                    onCancel={() => setDialog(null)}
                    onConfirm={(name, location) => {
                        const {entry} = dialog;
                        setDialog(null);
                        void duplicate(entry, name, location);
                    }}
                />
            )}

            {dialog?.kind === 'rename' && (
                <RenameFlowDialog
                    name={dialog.entry.flow.name}
                    folder={dialog.entry.inPlace ? null : dialog.entry.folder}
                    path={dialog.entry.inPlace ? dialog.entry.file : dialog.entry.path}
                    onCancel={() => setDialog(null)}
                    onConfirm={(result) => {
                        const {entry} = dialog;
                        setDialog(null);
                        void rename(entry, result);
                    }}
                />
            )}

            {dialog?.kind === 'delete' && (
                <ConfirmDialog
                    {...removal(dialog.entry)}
                    onCancel={() => setDialog(null)}
                    onConfirm={() => {
                        const {entry} = dialog;
                        setDialog(null);
                        void remove(entry);
                    }}
                />
            )}
        </div>
    );
}
