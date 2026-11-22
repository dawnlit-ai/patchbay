import type { CSSProperties, JSX } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { movePath } from '@shared/flow';
import type { MailboxFolderOption } from '@shared/ipc';

/** A path as Outlook would find it: no mailbox, one kind of separator, any case. */
export const folderKey = (path: string): string =>
    movePath(path).replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();

const segments = (path: string): string[] =>
    movePath(path).split(/[\\/]+/).map((s) => s.trim()).filter(Boolean);

// ── Outlook, asked once per mailbox ──────────────────────────────────────

/** Each mailbox's folders as last listed, so selecting a node again does not wait on Outlook. */
const listings = new Map<string, MailboxFolderOption[]>();
let outlookAccounts: string[] | null = null;

/** The mailboxes to list from: the flow's triggers', else every one Outlook has. Null while Outlook is asked. */
function useMailboxes(accounts: string[]): string[] | null {
    const [all, setAll] = useState<string[] | null>(outlookAccounts);
    const needed = accounts.length === 0;
    useEffect(() => {
        if (!needed || outlookAccounts) return;
        let cancelled = false;
        window.api.outlook.accounts().then(
            (list) => {
                outlookAccounts = list;
                if (!cancelled) setAll(list);
            },
            () => {
                if (!cancelled) setAll([]);
            },
        );
        return () => {
            cancelled = true;
        };
    }, [needed]);
    return needed ? all : accounts;
}

function useMailboxFolders(mailbox: string): {
    /** Null until Outlook has listed them. */
    listed: MailboxFolderOption[] | null;
    failed: string | null;
    busy: boolean;
    refresh(): void;
} {
    // Tagged with the mailbox they were listed for, so another's folders are never shown as this one's.
    const [listing, setListing] = useState<{ account: string; list: MailboxFolderOption[] } | null>(null);
    const [error, setError] = useState<{ account: string; message: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [reread, setReread] = useState(0);
    useEffect(() => {
        if (!mailbox) return;
        const cached = listings.get(mailbox);
        if (cached) {
            setListing({account: mailbox, list: cached});
            return;
        }
        let cancelled = false;
        setError(null);
        setBusy(true);
        window.api.outlook.mailboxFolders(mailbox).then(
            (list) => {
                listings.set(mailbox, list);
                if (cancelled) return;
                setListing({account: mailbox, list});
                setBusy(false);
            },
            (e: Error) => {
                if (cancelled) return;
                setError({account: mailbox, message: e.message});
                setBusy(false);
            },
        );
        return () => {
            cancelled = true;
        };
    }, [mailbox, reread]);
    return {
        // While a refresh is out, the folders listed before stay in sight.
        listed: listing?.account === mailbox ? listing.list : (mailbox && listings.get(mailbox)) || null,
        failed: error?.account === mailbox ? error.message : null,
        busy,
        refresh: () => {
            listings.delete(mailbox);
            setReread((n) => n + 1);
        },
    };
}

// ── The tree ─────────────────────────────────────────────────────────────

interface TreeNode {
    folder: MailboxFolderOption;
    key: string;
    parentKey: string | null;
    children: TreeNode[];
}

/** The folders Outlook keeps at the top of every mailbox, in the order its folder pane shows them. */
const TOP_ORDER = ['inbox', 'drafts', 'sent items', 'deleted items', 'archive', 'junk email', 'outbox'];

const byName = (a: TreeNode, b: TreeNode): number =>
    a.folder.name.localeCompare(b.folder.name, undefined, {sensitivity: 'base', numeric: true});

const rank = (node: TreeNode): number => {
    const at = TOP_ORDER.indexOf(node.folder.name.toLowerCase());
    return at < 0 ? TOP_ORDER.length : at;
};

/** The listing, depth-first, as a tree: Outlook's own folders first, then the rest by name. */
function buildTree(folders: MailboxFolderOption[]): TreeNode[] {
    const byKey = new Map<string, TreeNode>();
    const roots: TreeNode[] = [];
    for (const folder of folders) {
        const key = folderKey(folder.path);
        const cut = key.lastIndexOf('\\');
        const parentKey = cut >= 0 ? key.slice(0, cut) : null;
        const node: TreeNode = {folder, key, parentKey, children: []};
        byKey.set(key, node);
        const parent = parentKey === null ? undefined : byKey.get(parentKey);
        (parent ? parent.children : roots).push(node);
    }
    const sortAll = (nodes: TreeNode[]): void => {
        for (const node of nodes) {
            node.children.sort(byName);
            sortAll(node.children);
        }
    };
    roots.sort((a, b) => rank(a) - rank(b) || byName(a, b));
    sortAll(roots);
    return roots;
}

interface Row {
    node: TreeNode;
    depth: number;
}

function visibleRows(nodes: TreeNode[], expanded: ReadonlySet<string>, depth = 0, rows: Row[] = []): Row[] {
    for (const node of nodes) {
        rows.push({node, depth});
        if (expanded.has(node.key)) visibleRows(node.children, expanded, depth + 1, rows);
    }
    return rows;
}

function matchingRows(nodes: TreeNode[], needle: string, rows: Row[] = []): Row[] {
    for (const node of nodes) {
        if (node.folder.path.toLowerCase().includes(needle)) rows.push({node, depth: 0});
        matchingRows(node.children, needle, rows);
    }
    return rows;
}

/** Every folder above a path, as keys: what is opened to show it. */
function ancestorKeys(path: string): string[] {
    const parts = folderKey(path).split('\\');
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('\\'));
}

// ── Glyphs ───────────────────────────────────────────────────────────────

type Glyph = 'inbox' | 'drafts' | 'sent' | 'deleted' | 'archive' | 'junk' | 'folder';

const WELL_KNOWN_GLYPHS: Record<string, Glyph> = {
    'inbox': 'inbox',
    'drafts': 'drafts',
    'sent items': 'sent',
    'deleted items': 'deleted',
    'archive': 'archive',
    'junk email': 'junk',
};

/** Outlook's own folders by their look; any other, and anything below them, a plain folder. */
const glyphOf = (path: string): Glyph => {
    const parts = segments(path);
    return (parts.length === 1 && WELL_KNOWN_GLYPHS[parts[0]!.toLowerCase()]) || 'folder';
};

function FolderGlyph({glyph}: { glyph: Glyph }): JSX.Element {
    const lines: Record<Glyph, JSX.Element> = {
        folder: <path
            d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>,
        inbox: (
            <>
                <path d="M2 9.5 3.7 4.2a1 1 0 0 1 1-.7h6.6a1 1 0 0 1 1 .7L14 9.5V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>
                <path d="M2 9.5h3.2l.8 1.5h4l.8-1.5H14"/>
            </>
        ),
        drafts: <path d="m10.5 2.5 3 3L6 13H3v-3z"/>,
        sent: (
            <>
                <path d="M14 2 2 7l4.5 1.8L8.5 14z"/>
                <path d="M14 2 6.5 8.8"/>
            </>
        ),
        deleted: (
            <>
                <path d="M2.5 4.5h11"/>
                <path d="M6 4.5V3h4v1.5"/>
                <path d="m4 4.5.7 8.5h6.6l.7-8.5"/>
            </>
        ),
        archive: (
            <>
                <path d="M2 3h12v3.5H2z"/>
                <path d="M3 6.5V13h10V6.5"/>
                <path d="M6.5 9h3"/>
            </>
        ),
        junk: (
            <>
                <circle cx="8" cy="8" r="5.5"/>
                <path d="m4.2 4.2 7.6 7.6"/>
            </>
        ),
    };
    return (
        <svg className="folder-glyph" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
             strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {lines[glyph]}
        </svg>
    );
}

const Chevron = ({down = false}: { down?: boolean }): JSX.Element => (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={down ? 'm2 3.5 3 3 3-3' : 'm3.5 2 3 3-3 3'}/>
    </svg>
);

const Tick = (): JSX.Element => (
    <svg className="folder-tick" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m3 8.5 3 3 7-7"/>
    </svg>
);

/** Where a folder sits, for telling two of one name apart: “in Inbox › Clients”, or “at the top of the mailbox”. */
function whereIn(path: string): string {
    const above = segments(path).slice(0, -1);
    return above.length > 0 ? `in ${above.join(' › ')}` : 'at the top of the mailbox';
}

/** `Inbox › Processed › {{order.client}}`, each step its own span so a long one cuts short at the end. */
function Crumbs({path}: { path: string }): JSX.Element {
    const parts = segments(path);
    return (
        <span className="folder-crumbs" title={movePath(path)}>
            {parts.map((part, i) => (
                <span key={i}>
                    {i > 0 && <span className="folder-crumb-sep">›</span>}
                    {part}
                </span>
            ))}
        </span>
    );
}

// ── The field ────────────────────────────────────────────────────────────

/**
 * A Move email's folder: a box that opens onto the mailbox's folders, to pick
 * one from, find one by name, or name one that is not there yet. A path that
 * names a field in braces is typed instead, as it can be at any time.
 */
export function MailboxFolderPicker({id, accounts, value, fields, onChange}: {
    /** One per node: names the list and its options. */
    id: string;
    /** The mailboxes the flow's triggers watch. With none, every one Outlook has. */
    accounts: string[];
    value: string;
    /** The fields that reach the node, offered once `{{` is typed. */
    fields: string[];
    onChange(path: string): void;
}): JSX.Element {
    const mailboxes = useMailboxes(accounts);
    const [browsing, setBrowsing] = useState('');
    const mailbox = mailboxes?.includes(browsing) ? browsing : (mailboxes?.[0] ?? '');
    const {listed, failed, busy, refresh} = useMailboxFolders(mailbox);

    const [typing, setTyping] = useState(() => value.includes('{{'));
    const [open, setOpen] = useState(false);
    const control = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const input = useRef<HTMLInputElement>(null);
    /** Where focus goes once the list closes: back to the box it was opened from. */
    const refocus = useRef(false);
    useEffect(() => {
        if (open || !refocus.current) return;
        refocus.current = false;
        (typing ? input : trigger).current?.focus();
    }, [open, typing]);
    /** Set by the pencil: the path box takes focus once it is drawn. */
    const focusPath = useRef(false);
    useEffect(() => {
        if (!typing || !focusPath.current) return;
        focusPath.current = false;
        input.current?.focus();
        input.current?.select();
    }, [typing]);

    const path = movePath(value);
    const templated = path.includes('{{');
    const isNew = !!path && !!listed && !templated && !listed.some((f) => folderKey(f.path) === folderKey(path));

    const close = (focusBack: boolean): void => {
        refocus.current = focusBack;
        setOpen(false);
    };
    const pick = (picked: string): void => {
        onChange(picked);
        setTyping(picked.includes('{{'));
        close(true);
    };

    const openBrace = /^(.*\{\{)[^{}]*$/.exec(value);
    const suggestions = openBrace
        ? fields.map((f) => `${openBrace[1]}${f}}}`)
        : (listed ?? []).map((f) => f.path);

    const note =
        mailboxes === null
            ? 'Asking Outlook for its mailboxes…'
            : !mailbox
                ? 'Outlook lists no mailbox to pick a folder from.'
                : 'Asking Outlook for the folders…';

    return (
        <div className="field">
            <div className="folder-control" ref={control}>
                {typing ? (
                    <>
                        <input
                            ref={input}
                            value={value}
                            list={`${id}-paths`}
                            aria-label="Folder path"
                            placeholder="Inbox\Processed"
                            spellCheck={false}
                            onChange={(e) => onChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !value.includes('{{')) setTyping(false);
                            }}
                            onBlur={(e) => {
                                // Back to the box once it is a plain path, unless focus went next door.
                                if (control.current?.contains(e.relatedTarget as Node | null)) return;
                                if (!value.includes('{{')) setTyping(false);
                            }}
                        />
                        <datalist id={`${id}-paths`}>
                            {suggestions.map((s) => (
                                <option key={s} value={s}/>
                            ))}
                        </datalist>
                    </>
                ) : (
                    <button
                        ref={trigger}
                        type="button"
                        className="folder-trigger"
                        aria-haspopup="listbox"
                        aria-expanded={open}
                        onClick={() => (open ? close(false) : setOpen(true))}
                        onKeyDown={(e) => {
                            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                            e.preventDefault();
                            setOpen(true);
                        }}
                    >
                        <FolderGlyph glyph={glyphOf(path)}/>
                        {path ? <Crumbs path={path}/> :
                            <span className="folder-crumbs placeholder">Choose a folder…</span>}
                        {isNew && <span className="folder-badge"
                                        title="Outlook creates it the first time an email is filed there">new</span>}
                        <span className="folder-caret"><Chevron down/></span>
                    </button>
                )}
                <button
                    type="button"
                    className="ghost icon folder-mode"
                    title={typing ? 'Pick from the mailbox’s folders' : 'Type the path, to write a field into it'}
                    aria-label={typing ? 'Pick from the mailbox’s folders' : 'Type the path'}
                    onClick={() => {
                        if (typing) {
                            setOpen(!open);
                        } else {
                            focusPath.current = true;
                            setTyping(true);
                        }
                    }}
                >
                    {typing ? <FolderGlyph glyph="folder"/> : <FolderGlyph glyph="drafts"/>}
                </button>
            </div>
            {isNew && (
                <div className="hint">
                    {mailbox} has no {segments(path).join(' › ')} yet: Outlook creates it the first time an email is
                    filed there.
                </div>
            )}
            {templated && <div className="hint">Each run writes in the fields in braces before filing the email.</div>}
            {open && control.current && (
                <FolderPopover
                    id={id}
                    anchor={control.current}
                    listed={listed}
                    failed={failed}
                    busy={busy}
                    note={note}
                    mailboxes={mailboxes ?? []}
                    mailbox={mailbox}
                    value={value}
                    onMailbox={setBrowsing}
                    onRefresh={refresh}
                    onPick={pick}
                    onClose={close}
                />
            )}
        </div>
    );
}

// ── The list it opens ────────────────────────────────────────────────────

function FolderPopover({
                           id,
                           anchor,
                           listed,
                           failed,
                           busy,
                           note,
                           mailboxes,
                           mailbox,
                           value,
                           onMailbox,
                           onRefresh,
                           onPick,
                           onClose,
                       }: {
    id: string;
    anchor: HTMLElement;
    listed: MailboxFolderOption[] | null;
    failed: string | null;
    busy: boolean;
    note: string;
    mailboxes: string[];
    mailbox: string;
    value: string;
    onMailbox(mailbox: string): void;
    onRefresh(): void;
    onPick(path: string): void;
    onClose(focusBack: boolean): void;
}): JSX.Element {
    const [query, setQuery] = useState('');
    const tree = useMemo(() => buildTree(listed ?? []), [listed]);
    const chosen = folderKey(value);
    // Open down to the folder picked, and the Inbox, where most mail is filed.
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['inbox', ...ancestorKeys(value)]));
    const needle = query.trim().toLowerCase();
    const rows = needle ? matchingRows(tree, needle) : visibleRows(tree, expanded);
    const typed = movePath(query);
    // A path none of the folders has: offered as it is, for Outlook to create.
    const offered = typed && !rows.some((r) => r.node.key === folderKey(typed)) ? typed : '';
    const total = rows.length + (offered ? 1 : 0);

    const [active, setActive] = useState(0);
    useEffect(() => {
        setActive(needle ? 0 : Math.max(0, rows.findIndex((r) => r.node.key === chosen)));
        // Only when what is shown changes: not on every expand.
    }, [needle, tree]);
    useEffect(() => {
        document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({block: 'nearest'});
    }, [active, id]);

    const toggle = (key: string, to: boolean): void => {
        const next = new Set(expanded);
        if (to) next.add(key);
        else next.delete(key);
        setExpanded(next);
    };

    // Below the box, or above it when there is more room there. Hidden until placed, so it never jumps.
    const [place, setPlace] = useState<CSSProperties | null>(null);
    useLayoutEffect(() => {
        const box = anchor.getBoundingClientRect();
        const gap = 4;
        const margin = 8;
        const want = 360;
        const below = window.innerHeight - box.bottom - gap - margin;
        const above = box.top - gap - margin;
        const down = below >= Math.min(want, 240) || below >= above;
        const width = Math.max(box.width, 260);
        setPlace({
            left: Math.max(margin, Math.min(box.left, window.innerWidth - width - margin)),
            width,
            maxHeight: Math.min(want, down ? below : above),
            ...(down ? {top: box.bottom + gap} : {bottom: window.innerHeight - box.top + gap}),
        });
    }, [anchor]);

    const search = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (place) search.current?.focus();
    }, [place !== null]);

    // Escape anywhere, as a menu closes; leaving the window, or resizing it, closes it too.
    useEffect(() => {
        const key = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            onClose(true);
        };
        const away = (): void => onClose(false);
        window.addEventListener('keydown', key);
        window.addEventListener('blur', away);
        window.addEventListener('resize', away);
        return () => {
            window.removeEventListener('keydown', key);
            window.removeEventListener('blur', away);
            window.removeEventListener('resize', away);
        };
    }, [onClose]);

    const choose = (index: number): void => {
        const row = rows[index];
        if (row) onPick(row.node.folder.path);
        else if (offered && index === rows.length) onPick(offered);
    };

    let body: JSX.Element | null = null;
    if (!listed) {
        body = failed ? (
            <div className="folder-pop-note">
                Could not list the folders: {failed}
                <button type="button" className="compact" onClick={onRefresh}>Try again</button>
            </div>
        ) : (
            <div className="folder-pop-note">{note}</div>
        );
    } else if (listed.length === 0 && !offered) {
        body = <div className="folder-pop-note">Outlook lists no mail folders in this mailbox.</div>;
    } else if (total === 0) {
        body = <div className="folder-pop-note">Nothing matches.</div>;
    }

    return (
        <div
            className="menu-backdrop"
            onMouseDown={() => onClose(false)}
            onWheel={() => onClose(false)}
        >
            <div
                className="folder-pop"
                style={{...place, visibility: place ? 'visible' : 'hidden'}}
                onMouseDown={(e) => e.stopPropagation()}
                onWheel={(e) => e.stopPropagation()}
            >
                <div className="folder-pop-search">
                    <input
                        ref={search}
                        type="search"
                        role="combobox"
                        aria-expanded="true"
                        aria-controls={`${id}-list`}
                        aria-activedescendant={total > 0 ? `${id}-opt-${active}` : undefined}
                        aria-label="Find a folder"
                        placeholder="Find a folder, or type a new path…"
                        spellCheck={false}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            const row = rows[active];
                            const hasChildren = !!row && row.node.children.length > 0;
                            const isOpen = !!row && expanded.has(row.node.key);
                            switch (e.key) {
                                case 'ArrowDown':
                                    setActive(Math.min(total - 1, active + 1));
                                    break;
                                case 'ArrowUp':
                                    setActive(Math.max(0, active - 1));
                                    break;
                                case 'ArrowRight':
                                    if (needle || !hasChildren) return;
                                    if (!isOpen) toggle(row.node.key, true);
                                    else setActive(active + 1);
                                    break;
                                case 'ArrowLeft': {
                                    if (needle || !row) return;
                                    if (isOpen) {
                                        toggle(row.node.key, false);
                                        break;
                                    }
                                    const parent = rows.findIndex((r) => r.node.key === row.node.parentKey);
                                    if (parent < 0) return;
                                    setActive(parent);
                                    break;
                                }
                                case 'Enter':
                                    if (total === 0) return;
                                    choose(active);
                                    break;
                                case 'Tab':
                                    onClose(false);
                                    return;
                                default:
                                    return;
                            }
                            e.preventDefault();
                        }}
                    />
                </div>

                <div className="folder-pop-list" id={`${id}-list`} role="listbox" aria-label="Folders">
                    {body}
                    {rows.map((row, i) => {
                        const {folder, key, children} = row.node;
                        const isChosen = key === chosen;
                        const isOpen = expanded.has(key);
                        const within = needle ? whereIn(folder.path) : '';
                        return (
                            <div
                                key={key}
                                id={`${id}-opt-${i}`}
                                role="option"
                                aria-selected={isChosen}
                                className={`folder-opt${i === active ? ' active' : ''}${isChosen ? ' chosen' : ''}`}
                                style={{paddingLeft: 4 + row.depth * 16}}
                                title={folder.path}
                                onMouseMove={() => {
                                    if (active !== i) setActive(i);
                                }}
                                onClick={() => choose(i)}
                            >
                                {!needle && (
                                    <span
                                        className={`folder-twisty${isOpen ? ' open' : ''}`}
                                        onClick={(e) => {
                                            if (children.length === 0) return;
                                            e.stopPropagation();
                                            toggle(key, !isOpen);
                                        }}
                                    >
                                        {children.length > 0 && <Chevron/>}
                                    </span>
                                )}
                                <FolderGlyph glyph={glyphOf(folder.path)}/>
                                <span className="folder-opt-name">
                                    {folder.name}
                                    {within && <span className="folder-opt-within">{within}</span>}
                                </span>
                                {folder.itemCount > 0 && <span className="folder-opt-count">{folder.itemCount}</span>}
                                {isChosen && <Tick/>}
                            </div>
                        );
                    })}
                    {offered && (
                        <div
                            id={`${id}-opt-${rows.length}`}
                            role="option"
                            aria-selected={false}
                            className={`folder-opt folder-opt-new${active === rows.length ? ' active' : ''}`}
                            onMouseMove={() => {
                                if (active !== rows.length) setActive(rows.length);
                            }}
                            onClick={() => choose(rows.length)}
                        >
                            <span className="folder-opt-plus" aria-hidden="true">+</span>
                            <span className="folder-opt-name">
                                {offered.includes('{{') ? 'Use ' : 'New folder '}
                                <Crumbs path={offered}/>
                                <span className="folder-opt-within">
                                    {offered.includes('{{') ? 'each run writes in its fields' : whereIn(offered)}
                                </span>
                            </span>
                        </div>
                    )}
                </div>

                <div className="folder-pop-foot">
                    {mailboxes.length > 1 ? (
                        <select aria-label="Mailbox whose folders are listed" value={mailbox}
                                onChange={(e) => onMailbox(e.target.value)}>
                            {mailboxes.map((m) => (
                                <option key={m} value={m}>
                                    {m}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <span className="folder-pop-mailbox" title={mailbox}>{mailbox}</span>
                    )}
                    <button type="button" className="ghost compact" disabled={busy || !mailbox} onClick={onRefresh}>
                        {busy ? 'Listing…' : 'Refresh'}
                    </button>
                </div>
            </div>
        </div>
    );
}
