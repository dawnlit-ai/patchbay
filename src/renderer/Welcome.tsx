import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { findTriggers, type Flow } from '@shared/flow';
import type { FlowEntry } from '@shared/ipc';
import type { AboutInfo, EngineStatus } from '@shared/settings';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ContextMenu, type MenuItem } from './components/ContextMenu';
import { NameDialog } from './components/NameDialog';
import { RenameFlowDialog, type RenameResult } from './components/RenameFlowDialog';
import { WindowControls } from './components/WindowControls';
import { useTheme } from './theme';

/**
 * The start window: which flows this install holds, where each one lives, and
 * everything you can do to one without opening it. The canvas needs a flow before
 * it can draw anything, so this is what the app opens with — and a window of its
 * own rather than a screen inside the canvas, because a list wants the shape of a
 * list and the canvas wants the whole desk.
 */

/** Newest work first is the useful default; by name is for finding one you know. */
type Sort = 'recent' | 'name';

type Dialog =
    | { kind: 'new' }
    | { kind: 'duplicate'; entry: FlowEntry }
    | { kind: 'rename'; entry: FlowEntry }
    | { kind: 'delete'; entry: FlowEntry };

function ago(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return 'never';
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    return new Date(iso).toLocaleDateString();
}

/** What the graph amounts to, for someone deciding which flow this is. */
function shape(flow: Flow): string {
    if (flow.nodes.length === 0) return 'empty';
    const triggers = findTriggers(flow).length;
    const nodes = `${flow.nodes.length} node${flow.nodes.length === 1 ? '' : 's'}`;
    return triggers === 0 ? `${nodes} · no trigger` : `${nodes} · ${triggers} trigger${triggers === 1 ? '' : 's'}`;
}

/**
 * Where a flow lives, shortened so that a row stays a row. The folders above it
 * give way first and its own folder — the half that tells one flow from another
 * — is always there, which is what a plain end-of-line ellipsis would eat.
 *
 * Pointing at the path gives it back whole, on a panel hung below it: over the
 * row beneath, which the pointer has left, rather than over this row's own name.
 */
function Where({ path }: { path: string }): JSX.Element {
    // The separator goes with the half that is kept, so what is left reads as a
    // path with its middle taken out rather than two pieces set side by side.
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return (
        <code className="where">
            <span className="dir">{path.slice(0, Math.max(0, cut))}</span>
            <span className="base">{path.slice(Math.max(0, cut))}</span>
            {/* The same path a second time, for the eye only: the two halves
                above already read as the whole thing to anything listening. */}
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
    const [error, setError] = useState<string | null>(null);
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

    // Another window writes the same workspace: the canvas saves as it is edited,
    // and an agent may be editing it too. Announced changes are re-read, and so is
    // everything else the moment this window is looked at again.
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

    const attempt = async (what: () => Promise<unknown>): Promise<void> => {
        setError(null);
        try {
            await what();
        } catch (e) {
            setError((e as Error).message);
        }
    };

    /** Hands the flow to the canvas window, which this one then makes way for. */
    const open = (flowId: string): void => {
        void window.api.window.openFlow(flowId);
    };

    /** A flow you just made is one you meant to draw, so it opens on the canvas. */
    const create = (name: string): Promise<void> =>
        attempt(async () => open((await window.api.flows.create(name)).id));

    const duplicate = (entry: FlowEntry, name: string): Promise<void> =>
        attempt(async () => {
            const copy = await window.api.flows.duplicate(entry.flow, name);
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

    const importFlow = (): Promise<void> =>
        attempt(async () => {
            const imported = await window.api.flows.pickAndImport();
            if (imported) open(imported.id);
        });

    // ── Keyboard ───────────────────────────────────────────────────────────

    const move = (from: FlowEntry, delta: number): void => {
        const at = shown.indexOf(from);
        const next = shown[Math.min(shown.length - 1, Math.max(0, at + delta))];
        if (!next || next === from) return;
        setSelectedId(next.flow.id);
        rows.current.get(next.flow.id)?.focus();
    };

    /**
     * Everything that can be done to one flow. It was a strip of buttons under
     * the list, which had to be read against whichever row was selected; the
     * same list opens on the row itself now, where a right-click asked for it.
     */
    const actions = (entry: FlowEntry): MenuItem[] => [
        { label: 'Open', onSelect: () => open(entry.flow.id) },
        { label: 'Open folder', onSelect: () => void window.api.flows.revealFolder(entry.flow.id) },
        { label: 'Rename…', separator: true, onSelect: () => setDialog({ kind: 'rename', entry }) },
        { label: 'Duplicate…', onSelect: () => setDialog({ kind: 'duplicate', entry }) },
        { label: 'Export…', onSelect: () => void attempt(() => window.api.flows.pickAndExport(entry.flow)) },
        { label: 'Delete', separator: true, danger: true, onSelect: () => setDialog({ kind: 'delete', entry }) },
    ];

    const nothingYet = entries !== null && entries.length === 0;

    return (
        <div className="app">
            <div className="topbar">
                {/* What the window is for, rather than what it is called: it opens
                    before anything else, and choosing is the only thing to do here. */}
                <span className="window-title">Open a flow</span>
                <span className="spacer"/>
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

                    <button className="primary wide" onClick={() => setDialog({ kind: 'new' })}>
                        ＋ New flow
                    </button>
                    <button className="wide" onClick={() => void importFlow()}>
                        ↓ Open flow file…
                    </button>

                    <span className="spacer"/>

                    <div className="section-title">Workspace</div>
                    <div className="side-note">
                        Every flow, skill, run and log this install holds sits under here.
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
                                onDoubleClick={() => open(entry.flow.id)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    setSelectedId(entry.flow.id);
                                    // The menu key and Shift+F10 raise this event too,
                                    // with no pointer behind it: that menu belongs to
                                    // the row itself, under its own left edge.
                                    const box = e.currentTarget.getBoundingClientRect();
                                    setMenu({
                                        entry,
                                        x: e.clientX || box.left + 16,
                                        y: e.clientY || box.bottom - 6,
                                    });
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') open(entry.flow.id);
                                    else if (e.key === 'ArrowDown') move(entry, 1);
                                    else if (e.key === 'ArrowUp') move(entry, -1);
                                    else return;
                                    e.preventDefault();
                                }}
                            >
                                <div className="grow">
                                    <div className="title">
                                        {entry.flow.name}
                                        {watched.has(entry.flow.id) && (
                                            <span className="badge ok" title="A trigger in this flow is being polled">
                                                <span className="dot live"/> watching
                                            </span>
                                        )}
                                    </div>
                                    <div className="meta">
                                        {shape(entry.flow)} · edited {ago(entry.flow.updatedAt)}
                                    </div>
                                </div>
                                <Where path={entry.path}/>
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
                <NameDialog
                    title="New flow"
                    label="Flow name"
                    initial="New flow"
                    confirmLabel="Create"
                    hint="It gets a folder of its own, named after it, and opens on the canvas."
                    onCancel={() => setDialog(null)}
                    onConfirm={(name) => {
                        setDialog(null);
                        void create(name);
                    }}
                />
            )}

            {dialog?.kind === 'duplicate' && (
                <NameDialog
                    title="Duplicate flow"
                    label="Name for the copy"
                    initial={`${dialog.entry.flow.name} copy`}
                    confirmLabel="Duplicate"
                    hint="The copy gets its own folder, and the skills belonging to this flow come with it."
                    onCancel={() => setDialog(null)}
                    onConfirm={(name) => {
                        const { entry } = dialog;
                        setDialog(null);
                        void duplicate(entry, name);
                    }}
                />
            )}

            {dialog?.kind === 'rename' && (
                <RenameFlowDialog
                    name={dialog.entry.flow.name}
                    folder={dialog.entry.folder}
                    path={dialog.entry.path}
                    onCancel={() => setDialog(null)}
                    onConfirm={(result) => {
                        const { entry } = dialog;
                        setDialog(null);
                        void rename(entry, result);
                    }}
                />
            )}

            {dialog?.kind === 'delete' && (
                <ConfirmDialog
                    title="Delete flow"
                    message={`Delete “${dialog.entry.flow.name}”? Its folder goes too, with the skills only this flow has. Runs already recorded stay. This cannot be undone.`}
                    confirmLabel="Delete"
                    onCancel={() => setDialog(null)}
                    onConfirm={() => {
                        const { entry } = dialog;
                        setDialog(null);
                        void remove(entry);
                    }}
                />
            )}
        </div>
    );
}
