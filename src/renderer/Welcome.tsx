import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    findTriggers,
    type Flow,
    type JsonSchema,
    nodeSchema,
    schemaRefs,
    type Schemas,
    schemaUsers,
} from '@shared/flow';
import type { FlowEntry, Readme, SchemaSummary, WorkspaceInfo } from '@shared/ipc';
import type { AboutInfo, EngineStatus, SkillSummary } from '@shared/settings';
import { ConfirmDialog, type Question } from './components/ConfirmDialog';
import { ContextMenu, type MenuItem } from './components/ContextMenu';
import { Markdown } from './components/Markdown';
import { NameDialog } from './components/NameDialog';
import { NewWorkspaceDialog } from './components/NewWorkspaceDialog';
import { OpenWhereDialog } from './components/OpenWhereDialog';
import { fileStem, RenameFlowDialog, type RenameResult } from './components/RenameFlowDialog';
import { SettingsButton } from './components/SettingsButton';
import { SchemaDialog } from './components/SchemaDialog';
import { SchemaFields } from './components/SchemaFields';
import { skillTemplate } from './components/SkillLibrary';
import { WindowControls } from './components/WindowControls';
import { useErrorBanner } from './errorBanner';
import { ago } from './format';
import { isObject } from './schemaShape';
import { useTheme } from './theme';

/**
 * The start window: the open workspace's flows, the skills and schemas they
 * share and its README, and what can be done to each without opening a canvas.
 * With no workspace open, the ones opened before, and making or opening another.
 */

/** Newest work first is the useful default; by name is for finding one you know. */
type Sort = 'recent' | 'name';

/** Which part of the workspace the main pane shows. */
type Tab = 'flows' | 'skills' | 'schemas' | 'readme';

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
    | { kind: 'edit-schema'; name: string | null; suggested?: string }
    | { kind: 'duplicate-schema'; name: string }
    | { kind: 'rename-schema'; name: string }
    | { kind: 'delete-schema'; name: string }
    /** Leaving the open workspace stops what it is doing; asked about first. */
    | { kind: 'switch'; question: Question; go(): void };

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

/** The skills a flow's nodes tick, each once. */
function ticksOf(flow: Flow): Set<string> {
    return new Set(
        flow.nodes.flatMap((node) =>
            node.config.kind === 'extractor' || node.config.kind === 'processor' ? node.config.skills : [],
        ),
    );
}

/** The fields a schema lists, or null when it is not a group of fields. */
const fieldNames = (schema: JsonSchema): string[] | null =>
    isObject(schema.properties) ? Object.keys(schema.properties) : null;

/** The nodes in each flow that use a named schema, directly or through another: “pre-alerts (3 nodes)”. */
function usedIn(entries: FlowEntry[], schemas: Schemas, name: string): string[] {
    return entries.flatMap(({flow}) => {
        const nodes = schemaUsers(flow, schemas, name).length;
        return nodes === 0 ? [] : [`“${flow.name}” (${nodes} node${nodes === 1 ? '' : 's'})`];
    });
}

/** Names as a sentence lists them: “A”, “A and B”, “A, B and C”. */
function listed(names: string[]): string {
    return together(names.map((name) => `“${name}”`));
}

/** Phrases as a sentence joins them: A, A and B, A, B and C. */
function together(phrases: string[]): string {
    return phrases.length < 2 ? (phrases[0] ?? '') : `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;
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
 * Buttons under the picked row. A double-click or a key pressed on one is the
 * button's alone: the row's own would open the item as well.
 */
function RowActions({children}: { children: ReactNode }): JSX.Element {
    return (
        <div className="row-actions" onDoubleClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {children}
        </div>
    );
}

export function Welcome(): JSX.Element {
    /** Undefined until main says; null when no workspace is open. */
    const [workspace, setWorkspace] = useState<WorkspaceInfo | null | undefined>(undefined);
    const [recent, setRecent] = useState<WorkspaceInfo[]>([]);
    const [entries, setEntries] = useState<FlowEntry[] | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [skills, setSkills] = useState<SkillSummary[] | null>(null);
    const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
    const [schemaList, setSchemaList] = useState<SchemaSummary[] | null>(null);
    const [selectedSchema, setSelectedSchema] = useState<string | null>(null);
    /** Undefined until read; null when the workspace has none. */
    const [readme, setReadme] = useState<Readme | null | undefined>(undefined);
    const [tab, setTab] = useState<Tab>('flows');
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<Sort>('recent');
    const [dialog, setDialog] = useState<Dialog | null>(null);
    /** The flow a right-click landed on, and where it landed. */
    const [menu, setMenu] = useState<{ entry: FlowEntry; x: number; y: number } | null>(null);
    /** The same for a skill, and for a schema. */
    const [skillMenu, setSkillMenu] = useState<{ name: string; x: number; y: number } | null>(null);
    const [schemaMenu, setSchemaMenu] = useState<{ name: string; x: number; y: number } | null>(null);
    /** The workspaces menu, or one recent workspace's, and where it opened. */
    const [workspaceMenu, setWorkspaceMenu] = useState<{
        items: MenuItem[];
        label: string;
        x: number;
        y: number
    } | null>(
        null,
    );
    const [about, setAbout] = useState<AboutInfo | null>(null);
    const [status, setStatus] = useState<EngineStatus | null>(null);
    const {error, attempt, report} = useErrorBanner();
    const [theme, setTheme] = useTheme();
    const rows = useRef(new Map<string, HTMLDivElement>());
    const skillRows = useRef(new Map<string, HTMLDivElement>());
    const schemaRows = useRef(new Map<string, HTMLDivElement>());

    const refreshSkills = useCallback(() => {
        void window.api.skills.list().then(setSkills);
    }, []);

    const refreshSchemas = useCallback(() => {
        void window.api.schemas.list().then(setSchemaList);
    }, []);

    const refresh = useCallback(() => {
        void window.api.workspace.current().then(setWorkspace);
        void window.api.workspace.recent().then(setRecent);
        void window.api.flows.entries().then((list) => {
            setEntries(list);
            // Whatever was selected, unless it has just been deleted from under us.
            setSelectedId((current) => (list.some((e) => e.flow.id === current) ? current : null));
        });
        refreshSkills();
        refreshSchemas();
        // Edited in another app: coming back to this window is what re-reads it.
        void window.api.workspace.readme().then(setReadme);
    }, [refreshSkills, refreshSchemas]);

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
        });
        window.addEventListener('focus', refresh);
        return () => {
            off();
            window.removeEventListener('focus', refresh);
        };
    }, [refresh, refreshSkills, refreshSchemas]);

    const watched = new Set(status?.watching.map((w) => w.flowId));

    const needle = query.trim().toLowerCase();
    const matches = (...texts: string[]): boolean =>
        needle === '' || texts.some((text) => text.toLowerCase().includes(needle));

    const shown = (entries ?? [])
        .filter((e) => matches(e.flow.name, fileStem(e.file)))
        .toSorted((a, b) =>
            sort === 'name'
                ? a.flow.name.localeCompare(b.flow.name)
                : b.flow.updatedAt.localeCompare(a.flow.updatedAt),
        );

    // Nothing chosen yet means the top of the list — under the default sort, the
    // flow last worked on, which is the one the window was most likely opened for.
    const selected = shown.find((e) => e.flow.id === selectedId) ?? shown[0] ?? null;

    /** Each skill ticked anywhere, and the flows that tick it, by name. */
    const tickedIn = new Map<string, string[]>();
    for (const {flow} of entries ?? []) {
        for (const name of ticksOf(flow)) tickedIn.set(name, [...(tickedIn.get(name) ?? []), flow.name]);
    }

    const shownSkills = (skills ?? [])
        .filter((s) => matches(s.name, s.description))
        .toSorted((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt)));
    const skillSelected = shownSkills.find((s) => s.name === selectedSkill) ?? shownSkills[0] ?? null;

    // Ticked but not in the library: deleted or renamed outside the app since, or
    // named by a flow imported from elsewhere. Those nodes stop at their error port.
    const inLibrary = new Set(skills?.map((s) => s.name));
    const missing =
        skills === null ? [] : [...tickedIn.keys()].filter((name) => !inLibrary.has(name) && matches(name)).toSorted();

    /** The named schemas a node can use, by name. */
    const schemas: Schemas = Object.fromEntries(
        (schemaList ?? []).flatMap((s) => (s.schema ? [[s.name, s.schema]] : [])),
    );
    const shownSchemas = (schemaList ?? [])
        .filter((s) =>
            matches(s.name, typeof s.schema?.description === 'string' ? s.schema.description : '', ...(s.schema ? (fieldNames(s.schema) ?? []) : [])),
        )
        .toSorted((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt)));
    const schemaSelected = shownSchemas.find((s) => s.name === selectedSchema) ?? shownSchemas[0] ?? null;

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
    const inFolder = new Set(schemaList?.map((s) => s.name));
    const missingSchemas =
        schemaList === null ? [] : [...namedBy.keys()].filter((name) => !inFolder.has(name) && matches(name)).toSorted();

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

    // ── Skills ─────────────────────────────────────────────────────────────

    /**
     * Open its SKILL.md in the system's app for `.md` files, or show its folder.
     * The list follows the folder, so a save there shows here unasked.
     */
    const handOff = (how: 'open' | 'reveal', name: string): Promise<void> =>
        attempt(async () => {
            try {
                await window.api.skills[how](name);
            } catch (e) {
                // Gone since the list was read: the list catches up as the banner says so.
                refreshSkills();
                throw e;
            }
        });

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
        {label: 'Edit SKILL.md', onSelect: () => void handOff('open', name)},
        {label: 'Show in folder', onSelect: () => void handOff('reveal', name)},
        {label: 'Delete…', separator: true, danger: true, onSelect: () => setDialog({kind: 'delete-skill', name})},
    ];

    // ── Schemas ────────────────────────────────────────────────────────────

    /**
     * Open its file in the system's app for `.json` files, or show it in its
     * folder. The list follows the folder, so a save there shows here unasked.
     */
    const handOffSchema = (how: 'open' | 'reveal', name: string): Promise<void> =>
        attempt(async () => {
            try {
                await window.api.schemas[how](name);
            } catch (e) {
                // Gone since the list was read: the list catches up as the banner says so.
                refreshSchemas();
                throw e;
            }
        });

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
            setDialog(null);
            return null;
        } catch (e) {
            return (e as Error).message;
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

    /** Renaming or deleting one rewrites the flows that name it, so both lists are read again. */
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
                refresh();
            }
        });

    /** What deleting a schema means for the nodes that use it. */
    const unsharing = (name: string): string => {
        const users = usedIn(entries ?? [], schemas, name);
        if (users.length === 0) return 'No node in any flow here uses it.';
        return `The nodes using it in ${together(users)} each keep a copy as their own, so nothing breaks; they just no longer share it.`;
    };

    /**
     * Edit it in the dialog — or, for a file the form cannot read, in the
     * system's app for `.json` files, where it can be put right.
     */
    const editSchema = (entry: SchemaSummary): void => {
        if (entry.schema) setDialog({kind: 'edit-schema', name: entry.name});
        else void handOffSchema('open', entry.name);
    };

    /** The actions for one schema, shown in its row's context menu. */
    const schemaActions = (entry: SchemaSummary): MenuItem[] => [
        ...(entry.schema ? [{label: 'Edit…', onSelect: () => editSchema(entry)}] : []),
        {label: 'Rename…', onSelect: () => setDialog({kind: 'rename-schema', name: entry.name})},
        ...(entry.schema ? [{
            label: 'Duplicate…',
            onSelect: () => setDialog({kind: 'duplicate-schema', name: entry.name})
        }] : []),
        {label: 'Open JSON file', separator: true, onSelect: () => void handOffSchema('open', entry.name)},
        {label: 'Show in folder', onSelect: () => void handOffSchema('reveal', entry.name)},
        {
            label: 'Delete…',
            separator: true,
            danger: true,
            onSelect: () => setDialog({kind: 'delete-schema', name: entry.name}),
        },
    ];

    // ── README ─────────────────────────────────────────────────────────────

    /** Written from a template and opened to be filled in; shown here once it is saved and this window looked at. */
    const writeReadme = (): Promise<void> =>
        attempt(async () => {
            await window.api.workspace.createReadme();
            refresh();
        });

    const editReadme = (): Promise<void> =>
        attempt(async () => {
            try {
                await window.api.workspace.editReadme();
            } catch (e) {
                // Gone since it was read: show that, as the banner says why.
                refresh();
                throw e;
            }
        });

    // ── Keyboard ───────────────────────────────────────────────────────────

    const move = (from: FlowEntry, delta: number): void => {
        const at = shown.indexOf(from);
        const next = shown[Math.min(shown.length - 1, Math.max(0, at + delta))];
        if (!next || next === from) return;
        setSelectedId(next.flow.id);
        rows.current.get(next.flow.id)?.focus();
    };

    const moveSkill = (from: SkillSummary, delta: number): void => {
        const at = shownSkills.indexOf(from);
        const next = shownSkills[Math.min(shownSkills.length - 1, Math.max(0, at + delta))];
        if (!next || next === from) return;
        setSelectedSkill(next.name);
        skillRows.current.get(next.name)?.focus();
    };

    const moveSchema = (from: SchemaSummary, delta: number): void => {
        const at = shownSchemas.indexOf(from);
        const next = shownSchemas[Math.min(shownSchemas.length - 1, Math.max(0, at + delta))];
        if (!next || next === from) return;
        setSelectedSchema(next.name);
        schemaRows.current.get(next.name)?.focus();
    };

    /** The actions for one flow, shown in its row's context menu. */
    const actions = (entry: FlowEntry): MenuItem[] => [
        {label: 'Open', onSelect: () => void open(entry.flow)},
        {label: 'Show file in folder', onSelect: () => void window.api.flows.reveal(entry.flow.id)},
        status?.flowIds.includes(entry.flow.id) === true
            ? {label: 'Stop watching', separator: true, onSelect: () => void setWatching(entry.flow.id, false)}
            : {label: 'Start watching', separator: true, onSelect: () => void setWatching(entry.flow.id, true)},
        {label: 'Rename…', separator: true, onSelect: () => setDialog({kind: 'rename', entry})},
        {label: 'Duplicate…', onSelect: () => setDialog({kind: 'duplicate', entry})},
        {label: 'Delete…', separator: true, danger: true, onSelect: () => setDialog({kind: 'delete', entry})},
    ];

    const noFlows = entries !== null && entries.length === 0;
    const noSkills = skills !== null && skills.length === 0;
    const noSchemas = schemaList !== null && schemaList.length === 0;
    /** Nothing in the list shown, so nothing to filter or order. */
    const nothingYet = tab === 'flows' ? noFlows : tab === 'skills' ? noSkills : noSchemas;

    /** Opens a menu under a button, as a right-click would at the pointer. */
    const menuUnder = (e: { currentTarget: HTMLElement }, label: string, items: MenuItem[]): void => {
        const box = e.currentTarget.getBoundingClientRect();
        setWorkspaceMenu({items, label, x: box.left, y: box.bottom + 2});
    };

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
                <div className="welcome-rail">
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
                                        title="Copies it into this workspace, with any skills it carries that this workspace does not have"
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
                                in{' '}
                                <code>skills</code> and <code>schemas</code>, and every run works in it.
                            </div>
                            <code className="path">{workspace.path}</code>
                            <button className="wide" onClick={() => void attempt(() => window.api.workspace.reveal())}>
                                Open workspace folder
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
                                    A workspace is a folder holding flows and the skills they share. Make a new one,
                                    or open a folder you already keep them in — a git repository, say.
                                </p>
                            </div>

                            <button className="primary wide" onClick={() => setDialog({kind: 'new-workspace'})}>
                                ＋ New workspace
                            </button>
                            <button
                                className="wide"
                                title="Its flows are read from its flows folder and its skills from its skills folder, each made when first needed"
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
                                    folder</b>{' '}
                                    uses one you have.
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
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        const box = e.currentTarget.getBoundingClientRect();
                                        setWorkspaceMenu({
                                            items: recentItems(w),
                                            label: w.name,
                                            x: e.clientX || box.left + 16,
                                            y: e.clientY || box.bottom - 6,
                                        });
                                    }}
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
                                    aria-checked={tab === 'readme'}
                                    title="The README.md at the top of the workspace folder, if it has one"
                                    onClick={() => setTab('readme')}
                                >
                                    README
                                </button>
                            </div>
                            <span className="spacer"/>
                            {tab === 'readme' && readme && (
                                <>
                                    <span className="readme-file">edited {ago(readme.updatedAt)}</span>
                                    <button
                                        className="ghost compact"
                                        title={`${readme.path}\nOpens it in the app your system opens .md files with`}
                                        onClick={() => void editReadme()}
                                    >
                                        Open {readme.path.split(/[\\/]/).pop()}
                                    </button>
                                </>
                            )}
                            {tab !== 'readme' && !nothingYet && (
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

                        {tab === 'flows' && (
                            <div className="flow-list" role="listbox" aria-label="Flows">
                                {(entries === null || workspace === undefined) && <div className="empty">Loading…</div>}
                                {noFlows && workspace && (
                                    <div className="empty">
                                        No flows in {workspace.name} yet. <b>New flow</b> gives you a canvas, saved in
                                        its <code>flows</code> folder.
                                    </div>
                                )}
                                {entries !== null && !noFlows && shown.length === 0 && (
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
                                    </div>
                                ))}
                            </div>
                        )}

                        {tab === 'skills' && (
                            <div className="flow-list" role="listbox" aria-label="Skills">
                                {(skills === null || workspace === undefined) && <div className="empty">Loading…</div>}
                                {noSkills && missing.length === 0 && workspace && (
                                    <div className="empty">
                                        No skills in {workspace.name} yet. <b>New skill</b> writes one from a template
                                        into
                                        its <code>skills</code> folder, and <b>Import skills</b> copies in ones you
                                        have.
                                    </div>
                                )}
                                {skills !== null && !noSkills && shownSkills.length === 0 && missing.length === 0 && (
                                    <div className="empty">Nothing matches “{query}”.</div>
                                )}
                                {shownSkills.map((skill) => {
                                    const users = tickedIn.get(skill.name) ?? [];
                                    return (
                                        <div
                                            key={skill.name}
                                            ref={(el) => {
                                                if (el) skillRows.current.set(skill.name, el);
                                                else skillRows.current.delete(skill.name);
                                            }}
                                            role="option"
                                            aria-selected={skill === skillSelected}
                                            tabIndex={0}
                                            className={`flow-row${skill === skillSelected ? ' active' : ''}`}
                                            title={skill.description || undefined}
                                            onClick={() => setSelectedSkill(skill.name)}
                                            onDoubleClick={() => void handOff('open', skill.name)}
                                            onContextMenu={(e) => {
                                                e.preventDefault();
                                                setSelectedSkill(skill.name);
                                                const box = e.currentTarget.getBoundingClientRect();
                                                setSkillMenu({
                                                    name: skill.name,
                                                    x: e.clientX || box.left + 16,
                                                    y: e.clientY || box.bottom - 6,
                                                });
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') void handOff('open', skill.name);
                                                else if (e.key === 'ArrowDown') moveSkill(skill, 1);
                                                else if (e.key === 'ArrowUp') moveSkill(skill, -1);
                                                else return;
                                                e.preventDefault();
                                            }}
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
                                                <div className="meta">
                                                    {users.length > 0 ? `ticked in ${listed(users)}` : 'ticked in no flow'} ·
                                                    edited {ago(skill.updatedAt)}
                                                </div>
                                                {skill === skillSelected && (
                                                    <RowActions>
                                                        <button
                                                            title="Opens it in the app your system gives .md files. This list follows what you save there."
                                                            onClick={() => void handOff('open', skill.name)}
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
                                        </div>
                                    );
                                })}
                                {missing.map((name) => (
                                    <div key={`missing:${name}`} className="flow-row missing">
                                        <div className="grow">
                                            <div className="title">
                                                {name}
                                                <span className="badge err">not in this workspace</span>
                                            </div>
                                            <div className="meta">
                                                Ticked in {listed(tickedIn.get(name) ?? [])}, but there is no such skill
                                                in
                                                the <code>skills</code> folder, so the nodes that tick it stop at their
                                                error port. Import it, or untick it on the canvas.
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {tab === 'schemas' && (
                            <div className="flow-list" role="listbox" aria-label="Schemas">
                                {(schemaList === null || workspace === undefined) &&
                                    <div className="empty">Loading…</div>}
                                {noSchemas && missingSchemas.length === 0 && workspace && (
                                    <div className="empty">
                                        No schemas in {workspace.name} yet. A schema named here, in its{' '}
                                        <code>schemas</code> folder, can be picked by any Extractor or Processor in any
                                        of its flows, so each fills the same shape. <b>New schema</b> writes one from a
                                        template; a node’s <b>New…</b> on the canvas names the schema it has.
                                    </div>
                                )}
                                {schemaList !== null && !noSchemas && shownSchemas.length === 0 && missingSchemas.length === 0 && (
                                    <div className="empty">Nothing matches “{query}”.</div>
                                )}
                                {shownSchemas.map((entry) => {
                                    const users = entry.schema ? usedIn(entries ?? [], schemas, entry.name) : [];
                                    const fields = entry.schema ? fieldNames(entry.schema) : null;
                                    const description =
                                        typeof entry.schema?.description === 'string' ? entry.schema.description : '';
                                    const active = entry === schemaSelected;
                                    return (
                                        <div
                                            key={entry.name}
                                            ref={(el) => {
                                                if (el) schemaRows.current.set(entry.name, el);
                                                else schemaRows.current.delete(entry.name);
                                            }}
                                            role="option"
                                            aria-selected={active}
                                            tabIndex={0}
                                            className={`flow-row${active ? ' active' : ''}`}
                                            onClick={() => setSelectedSchema(entry.name)}
                                            onDoubleClick={() => editSchema(entry)}
                                            onContextMenu={(e) => {
                                                e.preventDefault();
                                                setSelectedSchema(entry.name);
                                                const box = e.currentTarget.getBoundingClientRect();
                                                setSchemaMenu({
                                                    name: entry.name,
                                                    x: e.clientX || box.left + 16,
                                                    y: e.clientY || box.bottom - 6,
                                                });
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') editSchema(entry);
                                                else if (e.key === 'ArrowDown') moveSchema(entry, 1);
                                                else if (e.key === 'ArrowUp') moveSchema(entry, -1);
                                                else return;
                                                e.preventDefault();
                                            }}
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
                                                {!active && fields && fields.length > 0 && (
                                                    <div className="meta fields">{fields.join(' · ')}</div>
                                                )}
                                                <div className="meta">
                                                    {fields && `${fields.length} field${fields.length === 1 ? '' : 's'} · `}
                                                    {users.length > 0 ? `used in ${together(users)}` : 'used in no flow'} ·
                                                    edited {ago(entry.updatedAt)}
                                                </div>
                                                {active && entry.schema && <SchemaFields schema={entry.schema}/>}
                                                {active && (
                                                    <RowActions>
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
                                        </div>
                                    );
                                })}
                                {missingSchemas.map((name) => (
                                    <div key={`missing:${name}`} className="flow-row missing">
                                        <div className="grow">
                                            <div className="title">
                                                {name}
                                                <span className="badge err">not in this workspace</span>
                                            </div>
                                            <div className="meta">
                                                Named by {together(namedBy.get(name) ?? [])}, but there is no{' '}
                                                <code>schemas/{name}.json</code>, so the nodes that use it are flagged
                                                on the canvas and stop at their error port. Create it here, put the
                                                file back, or pick another schema on those nodes.
                                            </div>
                                        </div>
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
                                    </div>
                                ))}
                            </div>
                        )}

                        {tab === 'readme' && (
                            <div className="readme-view">
                                {readme === undefined && <div className="empty">Loading…</div>}
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
                    label={menu.entry.flow.name}
                    items={actions(menu.entry)}
                    onClose={() => setMenu(null)}
                />
            )}

            {skillMenu && (
                <ContextMenu
                    x={skillMenu.x}
                    y={skillMenu.y}
                    label={skillMenu.name}
                    items={skillActions(skillMenu.name)}
                    onClose={() => setSkillMenu(null)}
                />
            )}

            {schemaMenu && (
                <ContextMenu
                    x={schemaMenu.x}
                    y={schemaMenu.y}
                    label={schemaMenu.name}
                    items={
                        schemaList?.find((s) => s.name === schemaMenu.name)
                            ? schemaActions(schemaList.find((s) => s.name === schemaMenu.name)!)
                            : []
                    }
                    onClose={() => setSchemaMenu(null)}
                />
            )}

            {workspaceMenu && (
                <ContextMenu
                    x={workspaceMenu.x}
                    y={workspaceMenu.y}
                    label={workspaceMenu.label}
                    items={workspaceMenu.items}
                    onClose={() => setWorkspaceMenu(null)}
                />
            )}

            {dialog?.kind === 'new' && workspace && (
                <NameDialog
                    title="New flow"
                    label="Flow name"
                    initial="New flow"
                    confirmLabel="Create"
                    hint={`Saved in ${workspace.name}’s flows folder, in a file named after it.`}
                    onCancel={() => setDialog(null)}
                    onConfirm={(name) => {
                        setDialog(null);
                        void create(name);
                    }}
                />
            )}

            {dialog?.kind === 'new-workspace' && (
                <NewWorkspaceDialog
                    onCancel={() => setDialog(null)}
                    onConfirm={(name, location) => {
                        setDialog(null);
                        void createWorkspace(name, location);
                    }}
                />
            )}

            {dialog?.kind === 'switch' && (
                <ConfirmDialog
                    {...dialog.question}
                    onCancel={() => setDialog(null)}
                    onConfirm={() => {
                        const {go} = dialog;
                        setDialog(null);
                        go();
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
                <NameDialog
                    title="Duplicate flow"
                    label="Flow name"
                    initial={`${dialog.entry.flow.name} copy`}
                    confirmLabel="Duplicate"
                    hint="Saved beside it, in a file of its own. It ticks the same skills, which the workspace shares."
                    onCancel={() => setDialog(null)}
                    onConfirm={(name) => {
                        const {entry} = dialog;
                        setDialog(null);
                        void duplicate(entry, name);
                    }}
                />
            )}

            {dialog?.kind === 'rename' && (
                <RenameFlowDialog
                    name={dialog.entry.flow.name}
                    file={dialog.entry.file}
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
                    title="Delete flow"
                    message={`Delete “${dialog.entry.flow.name}”? Its file, ${fileStem(dialog.entry.file)}.json, is deleted from the workspace’s flows folder. The skills and schemas it uses stay, since every flow here shares them, and so do runs already recorded. This cannot be undone.`}
                    confirmLabel="Delete"
                    onCancel={() => setDialog(null)}
                    onConfirm={() => {
                        const {entry} = dialog;
                        setDialog(null);
                        void remove(entry);
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
                    onCancel={() => setDialog(null)}
                    onConfirm={(name) => {
                        setDialog(null);
                        void createSkill(name);
                    }}
                />
            )}

            {dialog?.kind === 'delete-skill' && workspace && (
                <ConfirmDialog
                    title="Delete skill"
                    message={`Delete “${dialog.name}” from ${workspace.name}? Its whole folder goes with it. ${losing(dialog.name)} This cannot be undone.`}
                    confirmLabel="Delete"
                    onCancel={() => setDialog(null)}
                    onConfirm={() => {
                        const {name} = dialog;
                        setDialog(null);
                        void removeSkill(name);
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
                    onCancel={() => setDialog(null)}
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
                    onCancel={() => setDialog(null)}
                    onConfirm={(to) => {
                        const {name} = dialog;
                        setDialog(null);
                        void duplicateSchema(name, to);
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
                    onCancel={() => setDialog(null)}
                    onConfirm={(to) => {
                        const {name} = dialog;
                        setDialog(null);
                        if (to !== name) void renameSchema(name, to);
                    }}
                />
            )}

            {dialog?.kind === 'delete-schema' && workspace && (
                <ConfirmDialog
                    title="Delete schema"
                    message={`Delete ${dialog.name} from ${workspace.name}? Its file, schemas/${dialog.name}.json, is deleted. ${unsharing(dialog.name)} This cannot be undone.`}
                    confirmLabel="Delete"
                    onCancel={() => setDialog(null)}
                    onConfirm={() => {
                        const {name} = dialog;
                        setDialog(null);
                        void removeSchema(name);
                    }}
                />
            )}
        </div>
    );
}
