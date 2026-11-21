import type { JSX, MouseEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    findTriggers,
    type Flow,
    type JsonSchema,
    nodeSchema,
    schemaHolders,
    schemaRefs,
    type Schemas,
    schemaUsers,
} from '@shared/flow';
import type { FlowEntry, Readme, SchemaSummary, WorkspaceInfo } from '@shared/ipc';
import {
    type AboutInfo,
    type EngineStatus,
    type McpListing,
    type McpServerEntry,
    type McpServerState,
    type McpServerTool,
    type McpVariable,
    nodeTools,
    type SkillSummary,
} from '@shared/settings';
import { errorMessage, isObject, together } from '@shared/util';
import { ConfirmDialog, type Question } from './components/ConfirmDialog';
import { ContextMenu, type MenuItem } from './components/ContextMenu';
import { Markdown } from './components/Markdown';
import { Modal } from './components/Modal';
import { NameDialog } from './components/NameDialog';
import { NewWorkspaceDialog } from './components/NewWorkspaceDialog';
import { OpenWhereDialog } from './components/OpenWhereDialog';
import { Pane } from './components/Pane';
import { fileStem, RenameFlowDialog, type RenameResult } from './components/RenameFlowDialog';
import { SettingsButton } from './components/SettingsButton';
import { SchemaDialog } from './components/SchemaDialog';
import { SecretDialog } from './components/SecretDialog';
import { skillTemplate } from './components/SkillLibrary';
import { ThemeButton } from './components/ThemeButton';
import { WindowControls } from './components/WindowControls';
import { useErrorBanner } from './errorBanner';
import { ago } from './format';

/**
 * The start window: the open workspace's flows, the skills and schemas they
 * share and its README, and what can be done to each without opening a canvas.
 * With no workspace open, the ones opened before, and making or opening another.
 */

/** Newest work first is the useful default; by name is for finding one you know. */
type Sort = 'recent' | 'name';

/** Which part of the workspace the main pane shows. */
type Tab = 'flows' | 'skills' | 'schemas' | 'mcp' | 'readme';

type Dialog =
    | { kind: 'new' }
    | { kind: 'new-workspace' }
    /** A flow chosen while a canvas is up on another: which window it lands on. */
    | { kind: 'open'; flow: Flow; current: string }
    | { kind: 'duplicate'; entry: FlowEntry }
    | { kind: 'rename'; entry: FlowEntry }
    | { kind: 'delete'; entry: FlowEntry }
    | { kind: 'new-skill' }
    | { kind: 'delete-skill'; name: string }
    /** Making one (`name` null), perhaps under a name some node already uses, or changing one. */
    | { kind: 'edit-schema'; name: string | null; suggested?: string; viewing?: boolean }
    | { kind: 'duplicate-schema'; name: string }
    | { kind: 'rename-schema'; name: string }
    | { kind: 'delete-schema'; name: string }
    /** Leaving the open workspace stops what it is doing; asked about first. */
    | { kind: 'switch'; question: Question; go(): void }
    | { kind: 'set-secret'; server: McpServerEntry; variable: McpVariable };

/** A context menu, and where it opened. */
interface Menu {
    items: MenuItem[];
    label: string;
    x: number;
    y: number;
}

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

/** The skills a flow's nodes tick. */
function ticksOf(flow: Flow): string[] {
    return flow.nodes.flatMap((node) =>
        node.config.kind === 'extractor' || node.config.kind === 'processor' ? node.config.skills : [],
    );
}

/** The MCP servers a flow's nodes take tools of: ticked on the node, or granted by a skill it ticks. */
function mcpServersOf(skills: SkillSummary[]): (flow: Flow) => string[] {
    return (flow) =>
        flow.nodes.flatMap((node) =>
            node.config.kind === 'extractor' || node.config.kind === 'processor'
                ? nodeTools(node.config, skills).flatMap((entry) =>
                    entry.startsWith('mcp__') ? (entry.slice('mcp__'.length).split('__')[0] || []) : [],
                )
                : [],
        );
}

/** Each name `of` finds in the flows, and the flows it is found in, each once. */
function usersOf(entries: FlowEntry[] | null, of: (flow: Flow) => string[]): Map<string, string[]> {
    const users = new Map<string, string[]>();
    for (const {flow} of entries ?? []) {
        for (const name of new Set(of(flow))) users.set(name, [...(users.get(name) ?? []), flow.name]);
    }
    return users;
}

const serverKey = (server: McpServerEntry): string => `${server.source}:${server.name}`;

/**
 * Its tools are asked for again once what it starts, or where it connects, has
 * changed, or a value it looks up has been set or cleared.
 */
const toolsKey = (server: McpServerEntry): string =>
    `${serverKey(server)}:${server.summary}:${server.variables.map((v) => `${v.name}=${v.source}`).join(',')}`;

/** The values a server looks up that it has none of yet. */
const missingValues = (server: McpServerEntry): McpVariable[] => server.variables.filter((v) => v.source === 'missing');

/** Allowed, and with every value it looks up to be had: it can be started. */
const startable = (server: McpServerEntry): boolean => server.state === 'allowed' && missingValues(server).length === 0;

const canAllow = (server: McpServerEntry): boolean =>
    server.state === 'new' || server.state === 'changed' || server.state === 'blocked';

const canBlock = (server: McpServerEntry): boolean =>
    server.state === 'new' || server.state === 'changed' || server.state === 'allowed';

/** The badge each state wears in the MCP tab. Shadowed and invalid say why on hover. */
const SERVER_BADGES: Record<McpServerState, { label: string; tone: string; title?: string }> = {
    allowed: {label: 'allowed', tone: 'ok', title: 'Allowed to run in this workspace'},
    new: {label: 'needs approval', tone: 'warn', title: 'Defined in the workspace, and not allowed to run yet'},
    changed: {label: 'changed', tone: 'warn', title: 'Its definition changed since it was allowed'},
    blocked: {label: 'blocked', tone: '', title: 'Blocked in this workspace'},
    shadowed: {label: 'shadowed', tone: ''},
    invalid: {label: 'cannot be used', tone: 'err'},
};

/** Where a value a server looks up would come from, as the MCP tab says it. */
const VALUE_SOURCES: Record<McpVariable['source'], string> = {
    set: 'set here',
    environment: 'from the environment',
    default: 'its default',
    missing: 'missing',
};

/** The fields a schema lists, or null when it is not a group of fields. */
const fieldNames = (schema: JsonSchema): string[] | null =>
    isObject(schema.properties) ? Object.keys(schema.properties) : null;

/** The nodes in each flow that use a named schema, directly or through another: “Invoices” (3 nodes). */
function usedIn(entries: FlowEntry[], schemas: Schemas, name: string): string[] {
    return entries.flatMap(({flow}) => {
        const nodes = schemaUsers(flow, schemas, name).length;
        return nodes === 0 ? [] : [`“${flow.name}” (${nodes} node${nodes === 1 ? '' : 's'})`];
    });
}

/** Names as a sentence lists them: “A”, “A and B”, “A, B and C”. */
const listed = (names: string[]): string => together(names.map((name) => `“${name}”`));

/**
 * The row picked in a list: the one asked for, or before anything is, the top
 * of the list. Null once the user has unpicked it.
 */
function pickedIn<T>(shown: T[], wanted: string | null | undefined, keyOf: (item: T) => string): T | null {
    return wanted === null ? null : (shown.find((item) => keyOf(item) === wanted) ?? shown[0] ?? null);
}

/**
 * A path on one line, truncating the parent folders first so its own name
 * always shows. Hovering shows the whole path in a panel below.
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

/**
 * Whether a click on a row unpicks it. A second click on the picked row does,
 * but not the second click of a double-click, which opens it, nor the end of a
 * drag that selected some of its text to copy.
 */
const unpicks = (e: MouseEvent, picked: boolean): boolean =>
    picked && e.detail < 2 && (window.getSelection()?.isCollapsed ?? true);

/**
 * Controls inside the picked row. A click, double-click or key pressed on one is
 * the control's alone: the row's own would unpick or open the item as well.
 */
function RowActions({className = 'row-actions', children}: { className?: string; children: ReactNode }): JSX.Element {
    return (
        <div
            className={className}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
        >
            {children}
        </div>
    );
}

/** One of the main pane's lists, as its rows see it. */
interface Picking<T> {
    shown: T[];
    picked: T | null;
    /** Each row by key, for the arrow keys to move the focus. */
    rows: Map<string, HTMLDivElement>;

    keyOf(item: T): string;

    /** A key to pick, or null to unpick. */
    pick(key: string | null): void;
}

/**
 * A row of a list: picked by a click and unpicked by another, opened by a
 * double-click or Enter, moved through with the arrows, and right-clicked for
 * its menu.
 */
function ListRow<T>({list, item, title, onOpen, onMenu, children}: {
    list: Picking<T>;
    item: T;
    title?: string;
    onOpen(): void;
    onMenu(e: MouseEvent<HTMLDivElement>): void;
    children: ReactNode;
}): JSX.Element {
    const key = list.keyOf(item);
    const picked = item === list.picked;
    const move = (delta: number): void => {
        const at = list.shown.indexOf(item);
        const next = list.shown[Math.min(list.shown.length - 1, Math.max(0, at + delta))];
        if (!next || next === item) return;
        list.pick(list.keyOf(next));
        list.rows.get(list.keyOf(next))?.focus();
    };
    return (
        <div
            ref={(el) => {
                if (el) list.rows.set(key, el);
                else list.rows.delete(key);
            }}
            role="option"
            aria-selected={picked}
            tabIndex={0}
            className={`flow-row${picked ? ' active' : ''}`}
            title={title}
            onClick={(e) => list.pick(unpicks(e, picked) ? null : key)}
            onDoubleClick={onOpen}
            onContextMenu={(e) => {
                list.pick(key);
                onMenu(e);
            }}
            onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen();
                else if (e.key === 'ArrowDown') move(1);
                else if (e.key === 'ArrowUp') move(-1);
                else if (e.key === 'Escape') list.pick(null);
                else return;
                e.preventDefault();
            }}
        >
            {children}
        </div>
    );
}

/** A list of the main pane, which a click on its empty space unpicks. */
function PickList({label, onUnpick, children}: { label: string; onUnpick(): void; children: ReactNode }): JSX.Element {
    return (
        <div
            className="flow-list"
            role="listbox"
            aria-label={label}
            onClick={(e) => {
                if (e.target === e.currentTarget) onUnpick();
            }}
        >
            {children}
        </div>
    );
}

/** Something a flow or a schema names that the workspace does not have, or a file it cannot read. */
function MissingRow({name, badge = 'not in this workspace', action, children}: {
    name: string;
    badge?: string;
    action?: ReactNode;
    children: ReactNode;
}): JSX.Element {
    return (
        <div className="flow-row missing">
            <div className="grow">
                <div className="title">
                    {name}
                    <span className="badge err">{badge}</span>
                </div>
                <div className="meta">{children}</div>
            </div>
            {action}
        </div>
    );
}

export function Welcome(): JSX.Element {
    /** Undefined until main says; null when no workspace is open. */
    const [workspace, setWorkspace] = useState<WorkspaceInfo | null | undefined>(undefined);
    const [recent, setRecent] = useState<WorkspaceInfo[]>([]);
    const [entries, setEntries] = useState<FlowEntry[] | null>(null);
    /** Undefined before anything is picked; null when explicitly deselected. */
    const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
    const [skills, setSkills] = useState<SkillSummary[] | null>(null);
    const [selectedSkill, setSelectedSkill] = useState<string | null | undefined>(undefined);
    const [schemaList, setSchemaList] = useState<SchemaSummary[] | null>(null);
    const [selectedSchema, setSelectedSchema] = useState<string | null | undefined>(undefined);
    const [mcpListing, setMcpListing] = useState<McpListing | null>(null);
    const [selectedServer, setSelectedServer] = useState<string | null | undefined>(undefined);
    const [serverTools, setServerTools] = useState<
        Record<string, { tools: McpServerTool[] | null; error: string | null }>
    >({});
    /** Undefined until read; null when the workspace has none. */
    const [readme, setReadme] = useState<Readme | null | undefined>(undefined);
    const [tab, setTab] = useState<Tab>('flows');
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<Sort>('recent');
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const [menu, setMenu] = useState<Menu | null>(null);
    const [about, setAbout] = useState<AboutInfo | null>(null);
    const [status, setStatus] = useState<EngineStatus | null>(null);
    const {error, attempt, report} = useErrorBanner();
    /** The rows of whichever list is shown, by key. */
    const rows = useRef(new Map<string, HTMLDivElement>()).current;
    const fetchingTools = useRef(new Set<string>());

    const close = (): void => setDialog(null);

    const refreshSkills = useCallback(() => {
        void window.api.skills.list().then(setSkills);
    }, []);

    const refreshSchemas = useCallback(() => {
        void window.api.schemas.list().then(setSchemaList);
    }, []);

    const refreshMcp = useCallback(() => {
        void window.api.mcp.servers().then(setMcpListing);
    }, []);

    const refresh = useCallback(() => {
        void window.api.workspace.current().then(setWorkspace);
        void window.api.workspace.recent().then(setRecent);
        void window.api.flows.entries().then((list) => {
            setEntries(list);
            // Whatever was picked, unless it has just been deleted from under us:
            // then the top of the list again, as before anything was picked.
            setSelectedId((current) =>
                typeof current === 'string' && !list.some((e) => e.flow.id === current) ? undefined : current,
            );
        });
        refreshSkills();
        refreshSchemas();
        refreshMcp();
        // Edited in another app: coming back to this window is what re-reads it.
        void window.api.workspace.readme().then(setReadme);
    }, [refreshSkills, refreshSchemas, refreshMcp]);

    useEffect(() => {
        refresh();
        void window.api.about().then(setAbout);
        void window.api.engine.status().then(setStatus);
    }, [refresh]);

    useEffect(() => window.api.on.engineStatus(setStatus), []);

    // Canvases, agents and editors write the workspace too: re-read on their changes and on focus.
    useEffect(() => {
        const off = window.api.on.workspaceChanged((change) => {
            if (change.flows) {
                refresh();
                return;
            }
            if (change.skills) refreshSkills();
            if (change.schemas) refreshSchemas();
            if (change.mcp) refreshMcp();
        });
        window.addEventListener('focus', refresh);
        return () => {
            off();
            window.removeEventListener('focus', refresh);
        };
    }, [refresh, refreshSkills, refreshSchemas, refreshMcp]);

    const watched = new Set(status?.watching.map((w) => w.flowId));

    const needle = query.trim().toLowerCase();
    const matches = (...texts: string[]): boolean =>
        needle === '' || texts.some((text) => text.toLowerCase().includes(needle));

    /** By name, or the last edited first; a list with no edit times keeps its own order. */
    const ordered = <T, >(items: T[], name: (item: T) => string, edited?: (item: T) => string): T[] =>
        items.toSorted((a, b) =>
            sort === 'name' ? name(a).localeCompare(name(b)) : edited ? edited(b).localeCompare(edited(a)) : 0,
        );

    /** The names `named` holds that `present` lacks and the filter matches, once `present` has been read. */
    const absent = (named: Map<string, string[]>, present: string[] | undefined): string[] => {
        if (!present) return [];
        const there = new Set(present);
        return [...named.keys()].filter((name) => !there.has(name) && matches(name)).toSorted();
    };

    const shown = ordered(
        (entries ?? []).filter((e) => matches(e.flow.name, fileStem(e.file))),
        (e) => e.flow.name,
        (e) => e.flow.updatedAt,
    );
    // Nothing chosen yet means the top of the list — under the default sort, the
    // flow last worked on, which is the one the window was most likely opened for.
    const flows: Picking<FlowEntry> = {
        shown,
        picked: pickedIn(shown, selectedId, (e) => e.flow.id),
        keyOf: (e) => e.flow.id,
        pick: setSelectedId,
        rows,
    };

    /** Each skill ticked anywhere, and the flows that tick it, by name. */
    const tickedIn = usersOf(entries, ticksOf);
    const shownSkills = ordered(
        (skills ?? []).filter((s) => matches(s.name, s.description)),
        (s) => s.name,
        (s) => s.updatedAt,
    );
    const skillList: Picking<SkillSummary> = {
        shown: shownSkills,
        picked: pickedIn(shownSkills, selectedSkill, (s) => s.name),
        keyOf: (s) => s.name,
        pick: setSelectedSkill,
        rows,
    };
    // Ticked but not in the library: deleted or renamed outside the app since, or
    // named by a flow imported from elsewhere. Those nodes stop at their error port.
    const missing = absent(tickedIn, skills?.map((s) => s.name));

    /** The named schemas a node can use, by name. */
    const schemas: Schemas = Object.fromEntries(
        (schemaList ?? []).flatMap((s) => (s.schema ? [[s.name, s.schema]] : [])),
    );
    const shownSchemas = ordered(
        (schemaList ?? []).filter((s) =>
            matches(
                s.name,
                typeof s.schema?.description === 'string' ? s.schema.description : '',
                ...(s.schema ? (fieldNames(s.schema) ?? []) : []),
            ),
        ),
        (s) => s.name,
        (s) => s.updatedAt,
    );
    const schemaPicking: Picking<SchemaSummary> = {
        shown: shownSchemas,
        picked: pickedIn(shownSchemas, selectedSchema, (s) => s.name),
        keyOf: (s) => s.name,
        pick: setSelectedSchema,
        rows,
    };

    // Named by a node or by another schema, but not in the folder: deleted or
    // renamed outside the app since, or named by a flow imported from elsewhere.
    const namedBy = new Map<string, string[]>();
    const nameIt = (name: string, by: string): void => {
        const list = namedBy.get(name) ?? [];
        if (!list.includes(by)) namedBy.set(name, [...list, by]);
    };
    for (const {flow} of entries ?? []) {
        for (const node of flow.nodes) {
            const schema = nodeSchema(node);
            for (const name of schema ? schemaRefs(schema) : []) nameIt(name, `“${flow.name}”`);
        }
    }
    for (const {name: holder, schema} of schemaList ?? []) {
        for (const name of schema ? schemaRefs(schema) : []) nameIt(name, `the schema ${holder}`);
    }
    const missingSchemas = absent(namedBy, schemaList?.map((s) => s.name));

    /** Each MCP server ticked anywhere, and the flows that tick it, by name. */
    const serverTickedIn = usersOf(entries, mcpServersOf(skills ?? []));
    const shownServers = ordered(
        (mcpListing?.servers ?? []).filter((s) =>
            matches(
                s.name,
                s.source,
                s.type,
                s.summary,
                ...s.envKeys,
                ...s.headerKeys,
                ...s.variables.map((v) => v.name),
                s.problem ?? '',
            ),
        ),
        (s) => s.name,
    );
    const serverList: Picking<McpServerEntry> = {
        shown: shownServers,
        picked: pickedIn(shownServers, selectedServer, serverKey),
        keyOf: serverKey,
        pick: setSelectedServer,
        rows,
    };
    const missingServers = absent(serverTickedIn, mcpListing?.servers.map((s) => s.name));

    const toolsOf = tab === 'mcp' && serverList.picked && startable(serverList.picked) ? serverList.picked : null;
    const selectedToolKey = toolsOf && toolsKey(toolsOf);
    const selectedServerName = toolsOf?.name ?? null;

    useEffect(() => {
        if (!selectedToolKey || !selectedServerName) return;
        if (serverTools[selectedToolKey] !== undefined || fetchingTools.current.has(selectedToolKey)) return;
        fetchingTools.current.add(selectedToolKey);
        const settle = (tools: McpServerTool[] | null, error: string | null): void => {
            fetchingTools.current.delete(selectedToolKey);
            setServerTools((current) => ({...current, [selectedToolKey]: {tools, error}}));
        };
        void window.api.mcp.serverTools(selectedServerName).then(
            (tools) => settle(tools, null),
            (e: unknown) => settle(null, errorMessage(e)),
        );
    }, [selectedToolKey, selectedServerName, serverTools]);

    /** A row's menu, at the pointer — or under its left edge for the menu key and Shift+F10, which have none. */
    const menuAt = (e: MouseEvent<HTMLElement>, label: string, items: MenuItem[]): void => {
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        setMenu({items, label, x: e.clientX || box.left + 16, y: e.clientY || box.bottom - 6});
    };

    /** Opens a menu under a button, as a right-click would at the pointer. */
    const menuUnder = (e: { currentTarget: HTMLElement }, label: string, items: MenuItem[]): void => {
        const box = e.currentTarget.getBoundingClientRect();
        setMenu({items, label, x: box.left, y: box.bottom + 2});
    };

    /**
     * Hand something to another app: a file to open, or a folder to show. One gone
     * since its list was read is refused, and `reread` catches the list up as the
     * banner says why.
     */
    const handOff = (act: () => Promise<unknown>, reread: () => void): Promise<void> =>
        attempt(async () => {
            try {
                await act();
            } catch (e) {
                reread();
                throw e;
            }
        });

    // ── Workspaces ─────────────────────────────────────────────────────────

    /**
     * Leave the open workspace for another. Watching stops and every canvas closes,
     * so when either would, that is asked about first.
     */
    const leaveFor = async (what: string, go: () => Promise<unknown>): Promise<void> => {
        const run = (): Promise<void> =>
            attempt(async () => {
                const opened = await go();
                // Null: a folder picker was cancelled, and nothing changed.
                if (opened !== null) setQuery('');
                refresh();
            });
        const canvases = (await window.api.window.openFlows()).length;
        const watching = status?.flowIds.length ?? 0;
        if (!workspace || (canvases === 0 && watching === 0)) {
            await run();
            return;
        }
        const effects = [
            watching > 0 && `watching stops for ${watching} flow${watching === 1 ? '' : 's'}`,
            canvases > 0 && `${canvases === 1 ? 'the open canvas closes' : `the ${canvases} open canvases close`}`,
        ].filter(Boolean);
        setDialog({
            kind: 'switch',
            question: {
                title: 'Switch workspace',
                message: `Leave “${workspace.name}” for ${what}? ${effects.join(', and ').replace(/^./, (c) => c.toUpperCase())}. Its flows are as you left them when you come back.`,
                confirmLabel: 'Switch',
            },
            go: () => void run(),
        });
    };

    const openWorkspace = (target: WorkspaceInfo): Promise<void> =>
        leaveFor(`“${target.name}”`, () => window.api.workspace.open(target.path));

    const pickWorkspace = (): Promise<void> =>
        leaveFor('another folder', () => window.api.workspace.pickAndOpen());

    const createWorkspace = (name: string, location: string): Promise<void> =>
        leaveFor(`a new workspace`, () => window.api.workspace.create(name, location));

    const forgetWorkspace = (target: WorkspaceInfo): Promise<void> =>
        attempt(async () => {
            setRecent(await window.api.workspace.forget(target.path));
        });

    const others = recent.filter((w) => w.path !== workspace?.path);

    /** Every other workspace opened before, then making or opening one. */
    const switchItems = (): MenuItem[] => [
        ...others.map((w) => ({
            label: w.missing ? `${w.name} — not found` : w.name,
            onSelect: () => void openWorkspace(w),
        })),
        {label: 'Open folder…', separator: others.length > 0, onSelect: () => void pickWorkspace()},
        {label: 'New workspace…', onSelect: () => setDialog({kind: 'new-workspace'})},
    ];

    const recentItems = (w: WorkspaceInfo): MenuItem[] => [
        {label: 'Open', onSelect: () => void openWorkspace(w)},
        {label: 'Remove from list', separator: true, onSelect: () => void forgetWorkspace(w)},
    ];

    // ── Flows ──────────────────────────────────────────────────────────────

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
    const create = (name: string): Promise<void> =>
        attempt(async () => {
            const made = await window.api.flows.create(name);
            refresh();
            await open(made);
        });

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
                // Second, and separately: renaming the file is the half that can be
                // refused, and by then the rename it was keeping up with has landed.
                if (result.fileName !== null) await window.api.flows.setFileName(entry.flow.id, result.fileName);
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

    const importFile = (): Promise<void> =>
        attempt(async () => {
            const imported = await window.api.flows.pickAndImport();
            if (!imported) return;
            refresh();
            await open(imported);
        });

    /** The actions for one flow, shown in its row's context menu. */
    const flowActions = (entry: FlowEntry): MenuItem[] => [
        {label: 'Open', onSelect: () => void open(entry.flow)},
        {label: 'Show file in folder', onSelect: () => void window.api.flows.reveal(entry.flow.id)},
        status?.flowIds.includes(entry.flow.id) === true
            ? {label: 'Stop watching', separator: true, onSelect: () => void setWatching(entry.flow.id, false)}
            : {label: 'Start watching', separator: true, onSelect: () => void setWatching(entry.flow.id, true)},
        {label: 'Rename…', separator: true, onSelect: () => setDialog({kind: 'rename', entry})},
        {label: 'Duplicate…', onSelect: () => setDialog({kind: 'duplicate', entry})},
        {label: 'Delete…', separator: true, danger: true, onSelect: () => setDialog({kind: 'delete', entry})},
    ];

    // ── Skills ─────────────────────────────────────────────────────────────

    /**
     * Open its SKILL.md in the system's app for `.md` files. The list follows the
     * folder, so a save there shows here unasked.
     */
    const editSkill = (name: string): Promise<void> => handOff(() => window.api.skills.open(name), refreshSkills);

    /** Written from the template, then opened to be filled in. */
    const createSkill = (name: string): Promise<void> =>
        attempt(async () => {
            const clean = name.toLowerCase();
            await window.api.skills.create(clean, skillTemplate(clean));
            refreshSkills();
            setSelectedSkill(clean);
            await window.api.skills.open(clean);
        });

    const removeSkill = (name: string): Promise<void> =>
        attempt(async () => {
            try {
                await window.api.skills.remove(name);
            } finally {
                refreshSkills();
            }
        });

    const importSkills = (): Promise<void> =>
        attempt(async () => {
            const result = await window.api.skills.pickAndImport();
            if (!result) return;
            refreshSkills();
            if (result.imported[0] !== undefined) setSelectedSkill(result.imported[0]);
            // What came in is on the list; only what did not needs saying.
            if (result.skipped.length > 0) {
                report(`Imported ${result.imported.length}. Skipped ${result.skipped.join('; ')}.`);
            }
        });

    /** What deleting a skill costs the flows that tick it. */
    const losing = (name: string): string => {
        const users = tickedIn.get(name) ?? [];
        if (users.length === 0) return 'No flow here ticks it.';
        return `${listed(users)} tick${users.length === 1 ? 's' : ''} it, and those nodes will stop at their error port until it is unticked.`;
    };

    /** The actions for one skill, shown in its row's context menu. */
    const skillActions = (name: string): MenuItem[] => [
        {label: 'Edit SKILL.md', onSelect: () => void editSkill(name)},
        {label: 'Show in folder', onSelect: () => void handOff(() => window.api.skills.reveal(name), refreshSkills)},
        {label: 'Delete…', separator: true, danger: true, onSelect: () => setDialog({kind: 'delete-skill', name})},
    ];

    // ── Schemas ────────────────────────────────────────────────────────────

    /**
     * Open its file in the system's app for `.json` files, or show it in its
     * folder. The list follows the folder, so a save there shows here unasked.
     */
    const handOffSchema = (how: 'open' | 'reveal', name: string): Promise<void> =>
        handOff(() => window.api.schemas[how](name), refreshSchemas);

    /**
     * What the edit dialog saves: a new schema written, or one renamed, rewritten,
     * or both. Resolves to why it could not be, for the dialog to show while it
     * stays open with the edits, or null once it is written.
     */
    const saveSchema = async (from: string | null, to: string, schema: JsonSchema | null): Promise<string | null> => {
        try {
            if (from === null) {
                await window.api.schemas.create(to, schema ?? {});
            } else {
                if (to !== from) {
                    await window.api.schemas.rename(from, to);
                    // Should the rest fail, the dialog edits it under the name it has now.
                    setDialog({kind: 'edit-schema', name: to});
                }
                if (schema) await window.api.schemas.save(to, schema);
            }
            setSelectedSchema(to);
            close();
            return null;
        } catch (e) {
            return errorMessage(e);
        } finally {
            refresh();
        }
    };

    /** A copy under a name of its own, to start a new one from an old one. */
    const duplicateSchema = (from: string, to: string): Promise<void> =>
        attempt(async () => {
            const source = schemaList?.find((s) => s.name === from)?.schema;
            if (!source) throw new Error(`“${from}” is no longer in this workspace’s schemas folder.`);
            await window.api.schemas.create(to, source);
            refreshSchemas();
            setSelectedSchema(to);
        });

    /** The first name past `name` the folder does not hold, in any case. */
    const freeSchemaName = (name: string): string => {
        const taken = new Set(schemaList?.map((s) => s.name.toLowerCase()));
        let free = `${name}2`;
        for (let n = 3; taken.has(free.toLowerCase()); n++) free = `${name}${n}`;
        return free;
    };

    /** Who uses a schema, for the edit dialog to say under its name. */
    const usage = (name: string): string => {
        const users = usedIn(entries ?? [], schemas, name);
        return users.length === 0
            ? 'No node in any flow here uses it yet.'
            : `Used in ${together(users)}. A change here reaches every one of them.`;
    };

    /** Renaming one rewrites the flows that name it, so both lists are read again. */
    const renameSchema = (from: string, to: string): Promise<void> =>
        attempt(async () => {
            try {
                await window.api.schemas.rename(from, to);
                setSelectedSchema(to);
            } finally {
                refresh();
            }
        });

    const removeSchema = (name: string): Promise<void> =>
        attempt(async () => {
            try {
                await window.api.schemas.remove(name);
            } finally {
                refreshSchemas();
            }
        });

    /**
     * Each node and schema still naming it. No node keeps a schema of its own, so
     * while any does there is nowhere a copy could go, and deleting it is refused.
     */
    const holdersOf = (name: string): string[] =>
        schemaHolders(
            (entries ?? []).map((entry) => entry.flow),
            schemas,
            name,
        );

    /**
     * Look at it, or edit it, in the dialog — or, for a file the form cannot
     * read, open it in the system's app for `.json` files, where it can be put right.
     */
    const editSchema = (entry: SchemaSummary, viewing = false): void => {
        if (entry.schema) setDialog({kind: 'edit-schema', name: entry.name, viewing});
        else void handOffSchema('open', entry.name);
    };

    /** The actions for one schema, shown in its row's context menu. */
    const schemaActions = (entry: SchemaSummary): MenuItem[] => [
        ...(entry.schema
            ? [
                {label: 'View…', onSelect: () => editSchema(entry, true)},
                {label: 'Edit…', onSelect: () => editSchema(entry)},
            ]
            : []),
        {label: 'Rename…', onSelect: () => setDialog({kind: 'rename-schema', name: entry.name})},
        ...(entry.schema
            ? [{label: 'Duplicate…', onSelect: () => setDialog({kind: 'duplicate-schema', name: entry.name})}]
            : []),
        {label: 'Open JSON file', separator: true, onSelect: () => void handOffSchema('open', entry.name)},
        {label: 'Show in folder', onSelect: () => void handOffSchema('reveal', entry.name)},
        {
            label: 'Delete…',
            separator: true,
            danger: true,
            onSelect: () => setDialog({kind: 'delete-schema', name: entry.name}),
        },
    ];

    // ── MCP servers ────────────────────────────────────────────────────────

    /** Asked afresh next time, not shown what it offered before. */
    const forgetTools = (server: McpServerEntry): void =>
        setServerTools((current) =>
            Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${serverKey(server)}:`))),
        );

    const trustServer = (server: McpServerEntry, allowed: boolean): Promise<void> =>
        attempt(async () => {
            setMcpListing(await window.api.mcp.trustServer(server.name, allowed));
            // Allowed again after its file changed.
            forgetTools(server);
        });

    /** Null takes the value away, leaving the server to the environment or its default. */
    const setSecret = (server: McpServerEntry, variable: McpVariable, value: string | null): Promise<void> =>
        attempt(async () => {
            setMcpListing(await window.api.mcp.setServerSecret(server.name, variable.name, value));
            // A new token can change what a server offers, or let it answer at all.
            forgetTools(server);
        });

    const openMcpFile = (source: McpServerEntry['source']): Promise<void> =>
        handOff(() => window.api.mcp.openFile(source), refreshMcp);

    const revealMcpFile = (source: McpServerEntry['source']): Promise<void> =>
        handOff(() => window.api.mcp.revealFile(source), refreshMcp);

    const createMcpFile = (): Promise<void> =>
        attempt(async () => {
            await window.api.mcp.createFile();
            refreshMcp();
        });

    const serverActions = (server: McpServerEntry): MenuItem[] => {
        const items: MenuItem[] = [];
        if (canAllow(server)) {
            items.push({label: 'Allow in this workspace', onSelect: () => void trustServer(server, true)});
        }
        if (canBlock(server)) {
            items.push({label: 'Block in this workspace', onSelect: () => void trustServer(server, false)});
        }
        items.push(
            {
                label: `Edit ${server.source}`,
                separator: items.length > 0,
                onSelect: () => void openMcpFile(server.source),
            },
            {label: 'Show in folder', onSelect: () => void revealMcpFile(server.source)},
        );
        return items;
    };

    // ── README ─────────────────────────────────────────────────────────────

    /** Written from a template and opened to be filled in; shown here once it is saved and this window looked at. */
    const writeReadme = (): Promise<void> =>
        attempt(async () => {
            await window.api.workspace.createReadme();
            refresh();
        });

    /** One gone since it was read shows as gone, as the banner says why. */
    const editReadme = (): Promise<void> => handOff(() => window.api.workspace.editReadme(), refresh);

    const noFlows = entries !== null && entries.length === 0;
    const noSkills = skills !== null && skills.length === 0;
    const noSchemas = schemaList !== null && schemaList.length === 0;
    const noServers = mcpListing !== null && mcpListing.servers.length === 0 && mcpListing.unreadable.length === 0;
    /** Nothing in the list shown, so nothing to filter or order. */
    const nothingYet = {flows: noFlows, skills: noSkills, schemas: noSchemas, mcp: noServers, readme: true}[tab];
    const unmatched = <div className="empty">Nothing matches “{query}”.</div>;
    const loading = <div className="empty">Loading…</div>;

    return (
        <div className="app">
            <div className="topbar">
                {/* What the window is for, rather than what it is called. */}
                <span className="window-title">{workspace === null ? 'Open a workspace' : 'Open a flow'}</span>
                <span className="spacer"/>
                <SettingsButton/>
                <WindowControls maximize={false}/>
            </div>

            {error && <div className="err-banner inset">{error}</div>}

            <div className="welcome">
                <Pane className="welcome-rail" name="welcome-rail" edge="right" label="Resize the side panel">
                    {workspace ? (
                        <>
                            <div className="lede">
                                <h1>{workspace.name}</h1>
                                <p>
                                    A workspace keeps flows, and the skills and schemas they share, in one folder.
                                    Double-click a flow to draw it, or a skill or schema to edit it; right-click any of
                                    them for everything else, or start something new.
                                </p>
                            </div>

                            {tab === 'flows' ? (
                                <>
                                    <button className="primary wide" onClick={() => setDialog({kind: 'new'})}>
                                        ＋ New flow
                                    </button>
                                    <button
                                        className="wide"
                                        title="Copies a flow file from elsewhere into this workspace’s flows folder"
                                        onClick={() => void importFile()}
                                    >
                                        ↓ Import flow file…
                                    </button>
                                </>
                            ) : tab === 'schemas' ? (
                                <button
                                    className="primary wide"
                                    title="Name it and list its fields; it is saved in the workspace’s schemas folder"
                                    onClick={() => setDialog({kind: 'edit-schema', name: null})}
                                >
                                    ＋ New schema
                                </button>
                            ) : tab === 'mcp' ? (
                                <button
                                    className="primary wide"
                                    title="Opens .mcp.json at the top of the workspace folder, creating it from a template if there is none yet"
                                    onClick={() => void createMcpFile()}
                                >
                                    {mcpListing?.servers.some((s) => s.source === '.mcp.json') ||
                                    mcpListing?.unreadable.some((u) => u.source === '.mcp.json')
                                        ? 'Edit .mcp.json'
                                        : '＋ Create .mcp.json'}
                                </button>
                            ) : tab === 'readme' ? (
                                // One there is opened from the tab's own header.
                                readme === null && (
                                    <button
                                        className="primary wide"
                                        title="Writes a README.md at the top of the workspace folder from a template, and opens it"
                                        onClick={() => void writeReadme()}
                                    >
                                        ＋ Write a README
                                    </button>
                                )
                            ) : (
                                <>
                                    <button className="primary wide" onClick={() => setDialog({kind: 'new-skill'})}>
                                        ＋ New skill
                                    </button>
                                    <button
                                        className="wide"
                                        title="Copies each SKILL.md you choose, with the folder it is in, into this workspace. A skill here by the same name is replaced."
                                        onClick={() => void importSkills()}
                                    >
                                        ↓ Import skills…
                                    </button>
                                </>
                            )}

                            <span className="spacer"/>

                            <div className="section-title">Workspace</div>
                            <div className="side-note">
                                Flows are kept in its <code>flows</code> folder, the skills and schemas they share
                                in <code>skills</code> and <code>schemas</code>, and every run works in it.
                            </div>
                            <code className="path">{workspace.path}</code>
                            <button className="wide" onClick={() => void attempt(() => window.api.workspace.reveal())}>
                                Open workspace folder
                            </button>
                            <button
                                className="wide"
                                title="Saves its flows, skills, schemas, MCP server files and README as one zip to hand on. A file in .patchbay/export goes in place of its namesake."
                                onClick={() => void attempt(() => window.api.workspace.export())}
                            >
                                ↑ Export workspace…
                            </button>
                            <button
                                className="wide"
                                onClick={(e) => menuUnder(e, 'Workspaces', switchItems())}
                                title="Open another workspace, or make one. Watching stops and canvases close."
                            >
                                ⇄ Switch workspace…
                            </button>
                        </>
                    ) : workspace === null ? (
                        <>
                            <div className="lede">
                                <h1>Choose a workspace</h1>
                                <p>
                                    A workspace is a folder holding flows and the skills and schemas they share. Make
                                    a new one, or open a folder you already keep them in — a git repository, say.
                                </p>
                            </div>

                            <button className="primary wide" onClick={() => setDialog({kind: 'new-workspace'})}>
                                ＋ New workspace
                            </button>
                            <button
                                className="wide"
                                title="Its flows, skills and schemas are read from its flows, skills and schemas folders, each made when first needed"
                                onClick={() => void pickWorkspace()}
                            >
                                ↓ Open folder…
                            </button>

                            <span className="spacer"/>
                        </>
                    ) : (
                        // Main has not said yet which it is.
                        <span className="spacer"/>
                    )}

                    <div className="welcome-foot">
                        <ThemeButton/>
                        <span className="spacer"/>
                        {about && <span className="dim">v{about.version}</span>}
                    </div>
                </Pane>

                {workspace === null ? (
                    <div className="welcome-main">
                        <div className="welcome-head">
                            <strong>Recent workspaces</strong>
                            <span className="badge">{recent.length}</span>
                        </div>
                        <div className="flow-list" role="listbox" aria-label="Recent workspaces">
                            {recent.length === 0 && (
                                <div className="empty">
                                    None yet. <b>New workspace</b> makes a folder for your flows, or <b>Open
                                    folder</b> uses one you have.
                                </div>
                            )}
                            {recent.map((w) => (
                                <div
                                    key={w.path}
                                    role="option"
                                    aria-selected={false}
                                    tabIndex={0}
                                    className="flow-row"
                                    onDoubleClick={() => void openWorkspace(w)}
                                    onKeyDown={(e) => {
                                        if (e.key !== 'Enter') return;
                                        e.preventDefault();
                                        void openWorkspace(w);
                                    }}
                                    onContextMenu={(e) => menuAt(e, w.name, recentItems(w))}
                                >
                                    <div className="grow">
                                        <div className="title">
                                            {w.name}
                                            {w.missing && (
                                                <span className="badge" title="Moved, renamed or deleted since">
                                                    not found
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <Where path={w.path}/>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="welcome-main">
                        <div className="welcome-head">
                            <div className="segmented" role="radiogroup" aria-label="Show">
                                <button role="radio" aria-checked={tab === 'flows'} onClick={() => setTab('flows')}>
                                    Flows <span className="count">{entries?.length ?? 0}</span>
                                </button>
                                <button
                                    role="radio"
                                    aria-checked={tab === 'skills'}
                                    title="The skills every flow here shares, kept in the workspace’s skills folder"
                                    onClick={() => setTab('skills')}
                                >
                                    Skills <span className="count">{skills?.length ?? 0}</span>
                                </button>
                                <button
                                    role="radio"
                                    aria-checked={tab === 'schemas'}
                                    title="The named schemas every flow here shares, kept in the workspace’s schemas folder"
                                    onClick={() => setTab('schemas')}
                                >
                                    Schemas <span className="count">{schemaList?.length ?? 0}</span>
                                </button>
                                <button
                                    role="radio"
                                    aria-checked={tab === 'mcp'}
                                    title="The MCP servers this workspace defines, in .mcp.json and the other tools’ config files"
                                    onClick={() => setTab('mcp')}
                                >
                                    MCP{' '}
                                    <span className="count">
                                        {mcpListing?.servers.filter((s) => s.state !== 'shadowed').length ?? 0}
                                    </span>
                                </button>
                                <button
                                    role="radio"
                                    aria-checked={tab === 'readme'}
                                    title="The README.md at the top of the workspace folder, if it has one"
                                    onClick={() => setTab('readme')}
                                >
                                    README
                                </button>
                            </div>
                            {tab === 'readme' && readme && (
                                <div className="welcome-head-end">
                                    <span className="readme-file">edited {ago(readme.updatedAt)}</span>
                                    <button
                                        className="ghost compact"
                                        title={`${readme.path}\nOpens it in the app your system opens .md files with`}
                                        onClick={() => void editReadme()}
                                    >
                                        Open {readme.path.split(/[\\/]/).pop()}
                                    </button>
                                </div>
                            )}
                            {tab !== 'readme' && !nothingYet && (
                                <div className="welcome-head-end">
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
                                        <option value="recent">{tab === 'mcp' ? 'Source' : 'Last edited'}</option>
                                        <option value="name">Name</option>
                                    </select>
                                </div>
                            )}
                        </div>

                        {tab === 'flows' && (
                            <PickList label="Flows" onUnpick={() => setSelectedId(null)}>
                                {(entries === null || workspace === undefined) && loading}
                                {noFlows && workspace && (
                                    <div className="empty">
                                        No flows in {workspace.name} yet. <b>New flow</b> gives you a canvas, saved in
                                        its <code>flows</code> folder.
                                    </div>
                                )}
                                {entries !== null && !noFlows && shown.length === 0 && unmatched}
                                {shown.map((entry) => (
                                    <ListRow
                                        key={entry.flow.id}
                                        list={flows}
                                        item={entry}
                                        onOpen={() => void open(entry.flow)}
                                        onMenu={(e) => menuAt(e, entry.flow.name, flowActions(entry))}
                                    >
                                        <div className="grow">
                                            <div className="title">
                                                {entry.flow.name}
                                                {watched.has(entry.flow.id) ? (
                                                    <span className="badge ok"
                                                          title="A trigger in this flow is being polled">
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
                                        <Where path={entry.file}/>
                                    </ListRow>
                                ))}
                            </PickList>
                        )}

                        {tab === 'skills' && (
                            <PickList label="Skills" onUnpick={() => setSelectedSkill(null)}>
                                {(skills === null || workspace === undefined) && loading}
                                {noSkills && missing.length === 0 && workspace && (
                                    <div className="empty">
                                        No skills in {workspace.name} yet. <b>New skill</b> writes one from a template
                                        into its <code>skills</code> folder, and <b>Import skills</b> copies in ones you
                                        have.
                                    </div>
                                )}
                                {skills !== null && !noSkills && shownSkills.length === 0 && missing.length === 0 && unmatched}
                                {shownSkills.map((skill) => {
                                    const users = tickedIn.get(skill.name) ?? [];
                                    return (
                                        <ListRow
                                            key={skill.name}
                                            list={skillList}
                                            item={skill}
                                            title={skill.description || undefined}
                                            onOpen={() => void editSkill(skill.name)}
                                            onMenu={(e) => menuAt(e, skill.name, skillActions(skill.name))}
                                        >
                                            <div className="grow">
                                                <div className="title">
                                                    {skill.name}
                                                    {users.length === 0 && (
                                                        <span className="badge"
                                                              title="No node in any flow here ticks it">
                                                            unused
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="meta desc">{skill.description || 'No description'}</div>
                                                {skill.tools.length > 0 && (
                                                    <div className="meta"
                                                         title="Its allowed-tools: a node that ticks it is handed these.">
                                                        grants {skill.tools.join(', ')}
                                                    </div>
                                                )}
                                                <div className="meta">
                                                    {users.length > 0 ? `ticked in ${listed(users)}` : 'ticked in no flow'} ·
                                                    edited {ago(skill.updatedAt)}
                                                </div>
                                                {skill === skillList.picked && (
                                                    <RowActions>
                                                        <button
                                                            title="Opens it in the app your system gives .md files. This list follows what you save there."
                                                            onClick={() => void editSkill(skill.name)}
                                                        >
                                                            Edit SKILL.md
                                                        </button>
                                                        <button
                                                            className="danger"
                                                            onClick={() => setDialog({
                                                                kind: 'delete-skill',
                                                                name: skill.name
                                                            })}
                                                        >
                                                            Delete…
                                                        </button>
                                                    </RowActions>
                                                )}
                                            </div>
                                        </ListRow>
                                    );
                                })}
                                {missing.map((name) => (
                                    <MissingRow key={`missing:${name}`} name={name}>
                                        Ticked in {listed(tickedIn.get(name) ?? [])}, but there is no such skill in
                                        the <code>skills</code> folder, so the nodes that tick it stop at their error
                                        port. Import it, or untick it on the canvas.
                                    </MissingRow>
                                ))}
                            </PickList>
                        )}

                        {tab === 'schemas' && (
                            <PickList label="Schemas" onUnpick={() => setSelectedSchema(null)}>
                                {(schemaList === null || workspace === undefined) && loading}
                                {noSchemas && missingSchemas.length === 0 && workspace && (
                                    <div className="empty">
                                        No schemas in {workspace.name} yet. A schema named here, in its{' '}
                                        <code>schemas</code> folder, can be picked by any Extractor or Processor in any
                                        of its flows, so each fills the same shape. <b>New schema</b> writes one from a
                                        template; a node’s <b>New…</b> on the canvas makes one and picks it at once.
                                    </div>
                                )}
                                {schemaList !== null && !noSchemas && shownSchemas.length === 0 && missingSchemas.length === 0 && unmatched}
                                {shownSchemas.map((entry) => {
                                    const users = entry.schema ? usedIn(entries ?? [], schemas, entry.name) : [];
                                    const fields = entry.schema ? fieldNames(entry.schema) : null;
                                    const description =
                                        typeof entry.schema?.description === 'string' ? entry.schema.description : '';
                                    const active = entry === schemaPicking.picked;
                                    return (
                                        <ListRow
                                            key={entry.name}
                                            list={schemaPicking}
                                            item={entry}
                                            onOpen={() => editSchema(entry, true)}
                                            onMenu={(e) => menuAt(e, entry.name, schemaActions(entry))}
                                        >
                                            <div className="grow">
                                                <div className="title">
                                                    {entry.name}
                                                    {entry.problem ? (
                                                        <span className="badge err" title={entry.problem}>
                                                            cannot be used
                                                        </span>
                                                    ) : (
                                                        users.length === 0 && (
                                                            <span className="badge"
                                                                  title="No node in any flow here uses it">
                                                                unused
                                                            </span>
                                                        )
                                                    )}
                                                </div>
                                                <div className="meta desc">
                                                    {entry.problem ?? (description || 'No description')}
                                                </div>
                                                <div className="meta">
                                                    {fields && `${fields.length} field${fields.length === 1 ? '' : 's'} · `}
                                                    {users.length > 0 ? `used in ${together(users)}` : 'used in no flow'} ·
                                                    edited {ago(entry.updatedAt)}
                                                </div>
                                                {active && (
                                                    <RowActions>
                                                        {entry.schema && (
                                                            <button
                                                                onClick={() => editSchema(entry, true)}>View…</button>
                                                        )}
                                                        <button onClick={() => editSchema(entry)}>
                                                            {entry.schema ? 'Edit…' : 'Open JSON file'}
                                                        </button>
                                                        {entry.schema && (
                                                            <button
                                                                onClick={() => setDialog({
                                                                    kind: 'duplicate-schema',
                                                                    name: entry.name
                                                                })}
                                                            >
                                                                Duplicate…
                                                            </button>
                                                        )}
                                                        <button
                                                            className="danger"
                                                            onClick={() => setDialog({
                                                                kind: 'delete-schema',
                                                                name: entry.name
                                                            })}
                                                        >
                                                            Delete…
                                                        </button>
                                                    </RowActions>
                                                )}
                                            </div>
                                        </ListRow>
                                    );
                                })}
                                {missingSchemas.map((name) => (
                                    <MissingRow
                                        key={`missing:${name}`}
                                        name={name}
                                        action={
                                            <button
                                                className="fixed"
                                                onClick={() => setDialog({
                                                    kind: 'edit-schema',
                                                    name: null,
                                                    suggested: name
                                                })}
                                            >
                                                Create it…
                                            </button>
                                        }
                                    >
                                        Named by {together(namedBy.get(name) ?? [])}, but there is no{' '}
                                        <code>schemas/{name}.json</code>, so the nodes that use it are flagged on the
                                        canvas and stop at their error port. Create it here, put the file back, or pick
                                        another schema on those nodes.
                                    </MissingRow>
                                ))}
                            </PickList>
                        )}

                        {tab === 'mcp' && (
                            <PickList label="MCP servers" onUnpick={() => setSelectedServer(null)}>
                                {(mcpListing === null || workspace === undefined) && loading}
                                {noServers && missingServers.length === 0 && workspace && (
                                    <div className="empty">
                                        No MCP servers in {workspace.name} yet. Patchbay
                                        reads <code>.mcp.json</code>,{' '}
                                        <code>.vscode/mcp.json</code>, <code>.cursor/mcp.json</code> and{' '}
                                        <code>.gemini/settings.json</code> in the workspace folder. Servers you keep in
                                        Claude Code or agy for every project stay theirs, and no run is handed
                                        them. <b>Create .mcp.json</b> starts one at the top of the workspace.
                                    </div>
                                )}
                                {mcpListing !== null &&
                                    !noServers &&
                                    shownServers.length === 0 &&
                                    missingServers.length === 0 &&
                                    mcpListing.unreadable.length === 0 &&
                                    unmatched}
                                {mcpListing?.unreadable.map((u) => (
                                    <MissingRow
                                        key={`unreadable:${u.source}`}
                                        name={u.source}
                                        badge="cannot be read"
                                        action={
                                            <button className="fixed" onClick={() => void openMcpFile(u.source)}>
                                                Open file
                                            </button>
                                        }
                                    >
                                        {u.problem}
                                    </MissingRow>
                                ))}
                                {shownServers.map((server) => {
                                    const active = server === serverList.picked;
                                    const users = serverTickedIn.get(server.name) ?? [];
                                    const fetched = serverTools[toolsKey(server)];
                                    const badge = SERVER_BADGES[server.state];
                                    const unset = missingValues(server);
                                    const lead = server.summary ? `${server.summary} — ` : '';
                                    const description =
                                        server.problem ??
                                        (server.state === 'new'
                                            ? `${lead}Not allowed yet. A workspace server can run commands on this computer, so it stays off until you allow it.`
                                            : server.state === 'changed'
                                                ? `${lead}${server.source} changed what this starts since it was allowed. Allow it again to use it.`
                                                : server.summary || 'No command or URL');
                                    const details = [
                                        `in ${server.source}`,
                                        server.type,
                                        server.envKeys.length > 0 ? `env: ${server.envKeys.join(', ')}` : null,
                                        server.headerKeys.length > 0 ? `headers: ${server.headerKeys.join(', ')}` : null,
                                        users.length > 0 ? `ticked in ${listed(users)}` : 'ticked in no flow',
                                    ].filter((part): part is string => part !== null);
                                    const toolsNote = !fetched
                                        ? 'Listing tools…'
                                        : fetched.error
                                            ? `Could not list tools: ${fetched.error}`
                                            : fetched.tools?.length === 0
                                                ? 'This server reported no tools.'
                                                : null;
                                    return (
                                        <ListRow
                                            key={serverKey(server)}
                                            list={serverList}
                                            item={server}
                                            onOpen={() => void openMcpFile(server.source)}
                                            onMenu={(e) => menuAt(e, server.name, serverActions(server))}
                                        >
                                            <div className="grow">
                                                <div className="title">
                                                    {server.name}
                                                    <span className="badge">{server.source}</span>
                                                    <span
                                                        className={badge.tone ? `badge ${badge.tone}` : 'badge'}
                                                        title={badge.title ?? server.problem}
                                                    >
                                                        {badge.label}
                                                    </span>
                                                    {unset.length > 0 && (
                                                        <span
                                                            className="badge warn"
                                                            title={`Nothing starts it until ${unset.map((v) => v.name).join(', ')} has a value`}
                                                        >
                                                            needs a value
                                                        </span>
                                                    )}
                                                    {server.state === 'allowed' && users.length === 0 && (
                                                        <span className="badge"
                                                              title="No node in any flow here ticks it">
                                                            unused
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="meta desc">{description}</div>
                                                <div className="meta">{details.join(' · ')}</div>
                                                {active && server.variables.length > 0 && (
                                                    <RowActions className="schema-fields values">
                                                        {server.variables.map((variable) => (
                                                            <div key={variable.name} className="schema-field">
                                                                <span className="name">{variable.name}</span>
                                                                <span
                                                                    className={`type${variable.source === 'missing' ? ' warn' : ''}`}
                                                                >
                                                                    {VALUE_SOURCES[variable.source]}
                                                                </span>
                                                                <span
                                                                    className="desc">{variable.description ?? ''}</span>
                                                                <span className="value-actions">
                                                                    <button
                                                                        className="compact"
                                                                        onClick={() => setDialog({
                                                                            kind: 'set-secret',
                                                                            server,
                                                                            variable
                                                                        })}
                                                                    >
                                                                        {variable.source === 'set' ? 'Change…' : 'Set…'}
                                                                    </button>
                                                                    {variable.source === 'set' && (
                                                                        <button
                                                                            className="compact"
                                                                            title="Leave it to Patchbay’s environment, or the definition’s default"
                                                                            onClick={() => void setSecret(server, variable, null)}
                                                                        >
                                                                            Clear
                                                                        </button>
                                                                    )}
                                                                </span>
                                                            </div>
                                                        ))}
                                                    </RowActions>
                                                )}
                                                {active && server.state === 'allowed' && !startable(server) && (
                                                    <div className="schema-fields empty-fields">
                                                        Set {unset.map((v) => v.name).join(', ')} to start it and list
                                                        its tools.
                                                    </div>
                                                )}
                                                {active && startable(server) && toolsNote && (
                                                    <div className="schema-fields empty-fields">{toolsNote}</div>
                                                )}
                                                {active && startable(server) && !toolsNote && fetched?.tools && (
                                                    <div className="schema-fields tools">
                                                        {fetched.tools.map((tool) => (
                                                            <div key={tool.name} className="schema-field">
                                                                <span className="name">{tool.name}</span>
                                                                <span className="type">
                                                                    mcp__{server.name}__{tool.name}
                                                                </span>
                                                                <span className="desc"
                                                                      title={tool.description || undefined}>
                                                                    {tool.description || 'No description'}
                                                                </span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                                {active && (
                                                    <RowActions>
                                                        {canAllow(server) && (
                                                            <button className="primary"
                                                                    onClick={() => void trustServer(server, true)}>
                                                                Allow
                                                            </button>
                                                        )}
                                                        {canBlock(server) && (
                                                            <button
                                                                onClick={() => void trustServer(server, false)}>Block</button>
                                                        )}
                                                        <button onClick={() => void openMcpFile(server.source)}>
                                                            Edit {server.source}
                                                        </button>
                                                        <button onClick={() => void revealMcpFile(server.source)}>
                                                            Show in folder
                                                        </button>
                                                    </RowActions>
                                                )}
                                            </div>
                                        </ListRow>
                                    );
                                })}
                                {missingServers.map((name) => (
                                    <MissingRow key={`missing:${name}`} name={name}>
                                        Ticked in {listed(serverTickedIn.get(name) ?? [])}, but this workspace defines
                                        no server named <code>{name}</code>, so the nodes that tick it stop at their
                                        error port. Add it to <code>.mcp.json</code>, or untick it on the canvas.
                                    </MissingRow>
                                ))}
                            </PickList>
                        )}

                        {tab === 'readme' && (
                            <div className="readme-view">
                                {readme === undefined && loading}
                                {readme === null && workspace && (
                                    <div className="empty">
                                        {workspace.name} has no README. It is optional: a <code>README.md</code> at the
                                        top of the workspace folder, for what these flows are for and what someone
                                        looking after them should know. For a workspace that is a repository, it is the
                                        repository’s own README. <b>Write a README</b> starts one from a template.
                                    </div>
                                )}
                                {readme && <Markdown source={readme.content}/>}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    label={menu.label}
                    items={menu.items}
                    onClose={() => setMenu(null)}
                />
            )}

            {dialog?.kind === 'new' && workspace && (
                <NameDialog
                    title="New flow"
                    label="Flow name"
                    initial="New flow"
                    confirmLabel="Create"
                    hint={`Saved in ${workspace.name}’s flows folder, in a file named after it.`}
                    onCancel={close}
                    onConfirm={(name) => {
                        close();
                        void create(name);
                    }}
                />
            )}

            {dialog?.kind === 'new-workspace' && (
                <NewWorkspaceDialog
                    onCancel={close}
                    onConfirm={(name, location) => {
                        close();
                        void createWorkspace(name, location);
                    }}
                />
            )}

            {dialog?.kind === 'set-secret' && (
                <SecretDialog
                    server={dialog.server.name}
                    variable={dialog.variable}
                    onCancel={close}
                    onSave={(value) => {
                        close();
                        void setSecret(dialog.server, dialog.variable, value);
                    }}
                />
            )}

            {dialog?.kind === 'switch' && (
                <ConfirmDialog
                    {...dialog.question}
                    onCancel={close}
                    onConfirm={() => {
                        close();
                        dialog.go();
                    }}
                />
            )}

            {dialog?.kind === 'open' && (
                <OpenWhereDialog
                    name={dialog.flow.name}
                    current={dialog.current}
                    onCancel={close}
                    onChoose={(where) => {
                        close();
                        void window.api.window.openFlow(dialog.flow.id, where);
                    }}
                />
            )}

            {dialog?.kind === 'duplicate' && (
                <NameDialog
                    title="Duplicate flow"
                    label="Flow name"
                    initial={`${dialog.entry.flow.name} copy`}
                    confirmLabel="Duplicate"
                    hint="Saved beside it, in a file of its own. It uses the same skills and schemas, which the workspace shares."
                    onCancel={close}
                    onConfirm={(name) => {
                        close();
                        void duplicate(dialog.entry, name);
                    }}
                />
            )}

            {dialog?.kind === 'rename' && (
                <RenameFlowDialog
                    name={dialog.entry.flow.name}
                    file={dialog.entry.file}
                    onCancel={close}
                    onConfirm={(result) => {
                        close();
                        void rename(dialog.entry, result);
                    }}
                />
            )}

            {dialog?.kind === 'delete' && (
                <ConfirmDialog
                    title="Delete flow"
                    message={
                        `Delete “${dialog.entry.flow.name}”? ` +
                        `Its file, ${fileStem(dialog.entry.file)}.json, is deleted from the workspace’s flows folder. ` +
                        'The skills and schemas it uses stay, since every flow here shares them, and so do runs ' +
                        'already recorded. This cannot be undone.'
                    }
                    confirmLabel="Delete"
                    onCancel={close}
                    onConfirm={() => {
                        close();
                        void remove(dialog.entry);
                    }}
                />
            )}

            {dialog?.kind === 'new-skill' && workspace && (
                <NameDialog
                    title="New skill"
                    label="Skill name"
                    initial="my-skill"
                    confirmLabel="Create"
                    hint={`Lowercase and hyphens — it becomes its folder in ${workspace.name}’s skills folder. It opens from a template, to be filled in.`}
                    onCancel={close}
                    onConfirm={(name) => {
                        close();
                        void createSkill(name);
                    }}
                />
            )}

            {dialog?.kind === 'delete-skill' && workspace && (
                <ConfirmDialog
                    title="Delete skill"
                    message={
                        `Delete “${dialog.name}” ` +
                        `from ${workspace.name}? Its whole folder goes with it. ` +
                        `${losing(dialog.name)} This cannot be undone.`
                    }
                    confirmLabel="Delete"
                    onCancel={close}
                    onConfirm={() => {
                        close();
                        void removeSkill(dialog.name);
                    }}
                />
            )}

            {dialog?.kind === 'edit-schema' && (
                <SchemaDialog
                    name={dialog.name}
                    suggested={dialog.suggested}
                    schema={
                        dialog.name === null
                            ? undefined
                            : (schemaList?.find((s) => s.name === dialog.name)?.schema ?? undefined)
                    }
                    taken={schemaList?.map((s) => s.name) ?? []}
                    named={Object.keys(schemas)}
                    usage={dialog.name === null ? undefined : usage(dialog.name)}
                    viewing={dialog.viewing}
                    onCancel={close}
                    onSave={(to, schema) => saveSchema(dialog.name, to, schema)}
                    onDelete={
                        dialog.name === null
                            ? undefined
                            : () => setDialog({kind: 'delete-schema', name: dialog.name!})
                    }
                />
            )}

            {dialog?.kind === 'duplicate-schema' && (
                <NameDialog
                    title={`Duplicate ${dialog.name}`}
                    label="Schema name"
                    initial={freeSchemaName(dialog.name)}
                    confirmLabel="Duplicate"
                    hint="A copy of its fields under a name of its own, to change without changing the one it came from."
                    onCancel={close}
                    onConfirm={(to) => {
                        close();
                        void duplicateSchema(dialog.name, to);
                    }}
                />
            )}

            {dialog?.kind === 'rename-schema' && (
                <NameDialog
                    title={`Rename ${dialog.name}`}
                    label="Schema name"
                    initial={dialog.name}
                    confirmLabel="Rename"
                    hint="Its file is renamed, and every node and schema using it, in every flow here, follows."
                    onCancel={close}
                    onConfirm={(to) => {
                        close();
                        if (to !== dialog.name) void renameSchema(dialog.name, to);
                    }}
                />
            )}

            {dialog?.kind === 'delete-schema' && workspace && holdersOf(dialog.name).length > 0 && (
                <Modal
                    title={`${dialog.name} is in use`}
                    onClose={close}
                    footer={<button className="primary" onClick={close}>OK</button>}
                >
                    {`It is named by ${together(holdersOf(dialog.name))}. Every schema is the workspace’s, so there is no copy to leave them: have those use another schema first — pick one on each node, or change the field — and then delete it.`}
                </Modal>
            )}

            {dialog?.kind === 'delete-schema' && workspace && holdersOf(dialog.name).length === 0 && (
                <ConfirmDialog
                    title="Delete schema"
                    message={
                        `Delete ${dialog.name} ` +
                        `from ${workspace.name}? ` +
                        `Its file, schemas/${dialog.name}.json, is deleted. ` +
                        'No node or schema uses it. This cannot be undone.'
                    }
                    confirmLabel="Delete"
                    onCancel={close}
                    onConfirm={() => {
                        close();
                        void removeSchema(dialog.name);
                    }}
                />
            )}
        </div>
    );
}
