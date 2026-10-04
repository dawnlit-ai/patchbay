import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
    type AboutInfo,
    type AgentControlSettings,
    type AgentControlStatus,
    CONCURRENT_RUNS_RANGE,
    type GlobalSkillFolder,
    type McpServerSetting,
    type Settings,
    type SkillSummary,
} from '@shared/settings';
import type { AgentStatus, UsageWindow } from '@shared/ipc';
import { ahead, time } from '../format';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
    settings: Settings;
    about: AboutInfo | null;
    /** What the agent-control server is actually doing, as opposed to what is asked of it. */
    agentControl: AgentControlStatus | null;

    onSave(settings: Settings): void;

    onRegenerateToken(): void;
}

/** The settings window's content: a rail of pages, the current page, and Save. */

type Page = 'agents' | 'skills' | 'runs' | 'servers' | 'agent';

const PAGES: { id: Page; label: string }[] = [
    { id: 'agents', label: 'Agents' },
    { id: 'skills', label: 'Global skills' },
    { id: 'runs', label: 'Runs' },
    { id: 'servers', label: 'MCP servers' },
    { id: 'agent', label: 'Agent control' },
];

/**
 * What each page edits, for marking unsaved pages. The token and the skills link
 * are left out: main ignores both on save, so a stale copy here is not a change.
 */
const EDITS: Record<Page, (s: Settings) => unknown> = {
    agents: (s) => [s.claudeExecutablePath, s.agyExecutablePath],
    skills: (s) => s.skillSeedPath,
    runs: (s) => [s.pollingEnabled, s.maxConcurrentRuns],
    servers: (s) => s.mcpServers,
    agent: (s) => [s.agentControl.enabled, s.agentControl.port],
};

/** The skills the global library offers: each name once, from the highest folder holding it. */
const onShelf = (folders: GlobalSkillFolder[]): SkillSummary[] =>
    folders
        .flatMap((f) => f.skills.filter((s) => !s.shadowed))
        .toSorted((a, b) => a.name.localeCompare(b.name));

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const RUN_COUNTS = Array.from(
    { length: CONCURRENT_RUNS_RANGE.max - CONCURRENT_RUNS_RANGE.min + 1 },
    (_, i) => CONCURRENT_RUNS_RANGE.min + i,
);

/** How long "Copied" and "Changes saved" stay up before the words go back. */
const ACK_MS = 1800;

/** What to paste into a terminal to point Claude Code at this install. */
function connectCommand(status: AgentControlStatus): string {
    return `claude mcp add --transport http patchbay ${status.url} --header "Authorization: Bearer ${status.token}"`;
}

/** An on/off setting. A button rather than a checkbox, so it reads as a switch to a screen reader too. */
function Switch({ on, label, onChange }: { on: boolean; label: string; onChange(on: boolean): void }): JSX.Element {
    return <button className="switch" role="switch" aria-checked={on} aria-label={label}
                   onClick={() => onChange(!on)}/>;
}

/**
 * One setting: its name and what it does on the left, the control on the right
 * when it is small, or across the row beneath when it needs the width.
 */
function Row({
                 label,
                 description,
                 control,
                 below,
             }: {
    label: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
    below?: ReactNode;
}): JSX.Element {
    return (
        <div className="set-row">
            <div>
                <div className="set-label">{label}</div>
                {description && <div className="set-desc">{description}</div>}
            </div>
            {control && <div className="set-control">{control}</div>}
            {below && <div className="set-below">{below}</div>}
        </div>
    );
}

/** A plan's limits as bars: how much of each is used, and when it resets. */
function Usage({ usage }: { usage: UsageWindow[] }): JSX.Element | null {
    if (usage.length === 0) return null;
    return (
        <div className="usage">
            {usage.map((u) => (
                <div key={u.label} className="usage-row">
                    <span className="usage-label">{u.label}</span>
                    <span
                        className="usage-bar"
                        role="meter"
                        aria-label={`${u.label} used`}
                        aria-valuenow={u.percentUsed}
                        aria-valuemin={0}
                        aria-valuemax={100}
                    >
                        <span
                            className={`usage-fill${u.percentUsed >= 90 ? ' high' : u.percentUsed >= 70 ? ' mid' : ''}`}
                            style={{ width: `${Math.min(100, u.percentUsed)}%` }}
                        />
                    </span>
                    <span className="usage-pct">{u.percentUsed}% used</span>
                    <span className="usage-reset">{u.resetsAt ? `resets ${ahead(u.resetsAt)}` : ''}</span>
                </div>
            ))}
        </div>
    );
}

/** The agents the Agents page checks, each under its executable. */
const AGENTS = ['claude', 'agy'];

/** One agent's state under its executable: found, which version, signed in. */
function AgentState({ status, checking }: { status: AgentStatus | undefined; checking: boolean }): JSX.Element {
    if (!status) return <div className="agent-state">{checking ? 'Checking…' : 'Not checked.'}</div>;
    return (
        <div className={`agent-state ${status.ready ? 'ok' : 'bad'}`}>
            <span className="dot"/>
            <div>
                <strong>{status.version ? `${status.name} ${status.version}` : status.name}</strong>
                {' — '}
                {status.detail}
                {checking && <span className="agent-checking"> · checking again…</span>}
                <span className="set-from">{status.executable || 'The copy that comes with the Agent SDK'}</span>
                <Usage usage={status.usage}/>
            </div>
        </div>
    );
}

function PageHead({ title, children }: { title: string; children: ReactNode }): JSX.Element {
    return (
        <header className="set-head">
            <h1>{title}</h1>
            <p>{children}</p>
        </header>
    );
}

export function SettingsPanel({
                                  settings,
                                  about,
                                  agentControl,
                                  onSave,
                                  onRegenerateToken,
                              }: Props): JSX.Element {
    const [draft, setDraft] = useState<Settings>(settings);
    const [page, setPage] = useState<Page>('agents');
    /** The token stays dotted out unless asked for: a settings window gets screen-shared. */
    const [revealToken, setRevealToken] = useState(false);
    /** Which copy button just put something on the clipboard. */
    const [copied, setCopied] = useState<string | null>(null);
    const [justSaved, setJustSaved] = useState(false);
    /** Every folder the global library reads. Changed at once, not on Save. */
    const [folders, setFolders] = useState<GlobalSkillFolder[]>([]);
    const shelfSkills = onShelf(folders);
    const linkedFolders = folders.filter((f) => !f.workspace);
    const workspacePath = folders.find((f) => f.workspace)?.path;
    /** The global skill the delete question is about, while it is on screen. */
    const [deleting, setDeleting] = useState<SkillSummary | null>(null);
    const [skillsMessage, setSkillsMessage] = useState<{ text: string; bad: boolean } | null>(null);

    const edited = (p: Page): boolean => !same(EDITS[p](draft), EDITS[p](settings));
    const dirty = PAGES.some((p) => edited(p.id));

    // Each from the draft as it stands when React applies it, not as this render
    // saw it, so two edits landing before a re-render both survive.
    const patch = (partial: Partial<Settings>): void => setDraft((d) => ({ ...d, ...partial }));

    const patchServer = (index: number, partial: Partial<McpServerSetting>): void =>
        setDraft((d) => ({
            ...d,
            mcpServers: d.mcpServers.map((s, j) => (j === index ? { ...s, ...partial } : s)),
        }));

    const removeServer = (index: number): void =>
        setDraft((d) => ({ ...d, mcpServers: d.mcpServers.filter((_, j) => j !== index) }));

    const addServer = (): void =>
        setDraft((d) => ({
            ...d,
            mcpServers: [...d.mcpServers, { name: '', command: '', args: [], enabled: true }],
        }));

    /**
     * Each agent as the saved settings find it, shown as soon as its own check
     * ends: one slow agent does not hold up the other. Asked again on Save, as a
     * new path changes the answer.
     */
    const [agentStates, setAgentStates] = useState<Record<string, AgentStatus>>({});
    const [checking, setChecking] = useState<Record<string, boolean>>({});
    const agentChecks = useRef<Record<string, number>>({});
    const checkAgent = async (id: string): Promise<void> => {
        const mine = (agentChecks.current[id] ?? 0) + 1;
        agentChecks.current[id] = mine;
        const latest = (): boolean => agentChecks.current[id] === mine;
        setChecking((c) => ({ ...c, [id]: true }));
        try {
            const status = await window.api.agents.status(id);
            if (latest()) setAgentStates((states) => ({ ...states, [id]: status }));
        } finally {
            if (latest()) setChecking((c) => ({ ...c, [id]: false }));
        }
    };
    const checkAgents = (): void => AGENTS.forEach((id) => void checkAgent(id));
    const checkingAgents = AGENTS.some((id) => checking[id]);

    // What the last check this session found, at once, while the next one runs.
    useEffect(() => {
        for (const id of AGENTS) {
            void window.api.agents.lastStatus(id).then((last) => {
                if (last) setAgentStates((states) => (states[id] ? states : { ...states, [id]: last }));
            });
        }
    }, []);

    useEffect(checkAgents, [settings.claudeExecutablePath, settings.agyExecutablePath]);

    const patchAgent = (partial: Partial<AgentControlSettings>): void =>
        setDraft((d) => ({ ...d, agentControl: { ...d.agentControl, ...partial } }));

    const refreshSkills = async (): Promise<void> => {
        setFolders(await window.api.skills.folders());
    };

    // A canvas or an agent may change the library, and its folders are edited in
    // other apps too; coming back is when to look again.
    useEffect(() => {
        const refresh = (): void => void refreshSkills();
        refresh();
        window.addEventListener('focus', refresh);
        const off = window.api.on.workspaceChanged((change) => change.skills && refresh());
        return () => {
            window.removeEventListener('focus', refresh);
            off();
        };
    }, []);

    const skillsAction = async (act: () => Promise<string | null>): Promise<void> => {
        setSkillsMessage(null);
        try {
            const text = await act();
            if (text) setSkillsMessage({ text, bad: false });
        } catch (e) {
            setSkillsMessage({ text: e instanceof Error ? e.message : String(e), bad: true });
        }
    };

    /** Save a new folder list, saying which skills it stops offering: ticks on those now find nothing. */
    const changeFolders = (paths: string[], said = ''): Promise<void> =>
        skillsAction(async () => {
            const next = await window.api.skills.setFolders(paths);
            setFolders(next);
            const offered = new Set(onShelf(next).map((s) => s.name));
            const dropped = shelfSkills.map((s) => s.name).filter((n) => !offered.has(n));
            const text = `${said}${dropped.length > 0 ? ` No longer offered: ${dropped.join(', ')}.` : ''}`.trim();
            return text || null;
        });

    const linkedPaths = linkedFolders.map((f) => f.path);

    const linkFolder = (): Promise<void> =>
        skillsAction(async () => {
            const dir = await window.api.skills.pickFolder();
            if (dir) await changeFolders([...linkedPaths, dir], `Linked ${dir}.`);
            return null;
        });

    const importSkills = (): Promise<void> =>
        skillsAction(async () => {
            const result = await window.api.skills.pickAndImport('global', '');
            if (!result) return null;
            await refreshSkills();
            const said =
                result.imported.length > 0
                    ? `Imported ${result.imported.length}: ${result.imported.join(', ')}.`
                    : 'Nothing imported.';
            return result.skipped.length > 0 ? `${said} Skipped ${result.skipped.join('; ')}.` : said;
        });

    /** A copy of the same name further down, which takes over once this one goes. */
    const nextInLine = (skill: SkillSummary): GlobalSkillFolder | undefined =>
        folders.find((f) => f.skills.some((s) => s.name === skill.name && s.shadowed));

    const deleteSkill = (skill: SkillSummary): Promise<void> =>
        skillsAction(async () => {
            await window.api.skills.remove('global', '', skill.name);
            await refreshSkills();
            const next = nextInLine(skill);
            return next
                ? `Deleted “${skill.name}”. The copy in ${next.workspace ? 'the app workspace' : next.path} is used now.`
                : `Deleted “${skill.name}”.`;
        });

    /** In the app the system opens `.md` files with; the list follows the save. */
    const editSkill = (skill: SkillSummary): Promise<void> =>
        skillsAction(async () => {
            try {
                await window.api.skills.open('global', '', skill.name);
            } catch (e) {
                // Refused because it went since the list was read: catch the list up.
                await refreshSkills();
                throw e;
            }
            return null;
        });

    const deleteQuestion = (skill: SkillSummary): string => {
        const next = nextInLine(skill);
        const where = skill.folder === workspacePath ? 'the app workspace' : skill.folder;
        return (
            `Delete
            “
            ${skill.name}
            ”? Its whole folder is deleted from
            ${where}
            . ` +
            (next
                ? `Flows that tick it get the copy in ${next.workspace ? 'the app workspace' : next.path} instead.`
                : 'Every flow that ticks it loses it.')
        );
    };

    const moveFolder = (from: number, to: number): Promise<void> => {
        const next = [...linkedPaths];
        const [path] = next.splice(from, 1);
        next.splice(to, 0, path!);
        return changeFolders(next);
    };

    const revealFolder = (path: string): Promise<void> =>
        skillsAction(async () => {
            await window.api.skills.revealFolder(path);
            return null;
        });

    const copy = (what: string, text: string): void => {
        void window.api.copyText(text).then(() => {
            setCopied(what);
            setTimeout(() => setCopied((current) => (current === what ? null : current)), ACK_MS);
        });
    };

    // A new `settings` means Save went through. Compared by identity, so the first
    // render (and StrictMode's rerun) say nothing.
    const shown = useRef(settings);
    useEffect(() => {
        if (shown.current === settings) return;
        shown.current = settings;
        setJustSaved(true);
        const timer = setTimeout(() => setJustSaved(false), ACK_MS);
        return () => clearTimeout(timer);
    }, [settings]);

    // Ctrl+S, the way every other editor on the desk saves.
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
            e.preventDefault();
            if (dirty) onSave(draft);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [dirty, draft, onSave]);

    const enabledServers = draft.mcpServers.filter((s) => s.enabled).length;

    /** What the rail says about a page besides its name. */
    const meta = (p: Page): ReactNode => {
        if (p === 'skills') return <span className="meta">{shelfSkills.length}</span>;
        if (p === 'runs' && !draft.pollingEnabled) return <span className="meta">Off</span>;
        if (p === 'servers' && draft.mcpServers.length > 0) return <span className="meta">{enabledServers}</span>;
        if (p === 'agent' && agentControl?.running) {
            return (
                <span className="meta on">
                    <span className="dot"/>
                    On
                </span>
            );
        }
        return null;
    };

    return (
        <div className="settings">
            <nav className="set-rail" aria-label="Settings pages">
                {PAGES.map(({ id, label }) => (
                    <button
                        key={id}
                        className={`set-nav${page === id ? ' active' : ''}`}
                        aria-current={page === id ? 'page' : undefined}
                        onClick={() => setPage(id)}
                    >
                        {label}
                        {edited(id) && <span className="edited" title="Unsaved changes"/>}
                        <span className="spacer"/>
                        {meta(id)}
                    </button>
                ))}

                {about && (
                    <div className="set-about">
                        <div>
                            <strong>{about.name}</strong> {about.version}
                        </div>
                        <div>{about.license}</div>
                        <button className="set-link" onClick={() => void window.api.openDeveloperSite()}>
                            Made by {about.developer}
                        </button>
                    </div>
                )}
            </nav>

            <div className="set-main">
                <div className="set-scroll">
                    <div className="set-page">
                        {page === 'agents' && (
                            <>
                                <PageHead title="Agents">
                                    What your Categorizer, Extractor and Processor nodes run on: Claude, or the
                                    Antigravity CLI where a node picks a model marked · agy.
                                </PageHead>
                                <div className="set-group">
                                    <Row
                                        label="Claude executable"
                                        description="Leave it blank to use Claude Code on this computer, or the copy that comes with the Agent SDK. Set a path only if Patchbay can't find either."
                                        below={
                                            <>
                                                <input
                                                    className="mono"
                                                    aria-label="Claude executable"
                                                    value={draft.claudeExecutablePath}
                                                    placeholder="Found automatically"
                                                    onChange={(e) => patch({ claudeExecutablePath: e.target.value })}
                                                />
                                                <AgentState status={agentStates.claude}
                                                            checking={checking.claude === true}/>
                                            </>
                                        }
                                    />
                                    <Row
                                        label="agy executable"
                                        description="Leave it blank to use agy where it installs itself, in ~/.local/bin. Set a path only if it is somewhere else. Its models join the model lists once agy is found and signed in."
                                        below={
                                            <>
                                                <input
                                                    className="mono"
                                                    aria-label="agy executable"
                                                    value={draft.agyExecutablePath}
                                                    placeholder="Found automatically"
                                                    onChange={(e) => patch({ agyExecutablePath: e.target.value })}
                                                />
                                                <AgentState status={agentStates.agy} checking={checking.agy === true}/>
                                            </>
                                        }
                                    />
                                </div>
                                <div className="set-actions">
                                    <button disabled={checkingAgents} onClick={() => void checkAgents()}>
                                        {checkingAgents ? 'Checking…' : 'Check again'}
                                    </button>
                                </div>
                                <p className="set-note">
                                    Checked with the saved paths: a path typed above is checked once it is saved.
                                </p>
                            </>
                        )}

                        {page === 'skills' && (
                            <>
                                <PageHead title="Global skills">
                                    The shared shelf every flow can tick skills from. It holds the skills kept in
                                    the app workspace, where new ones are saved, and those in any folder linked
                                    here, read in place. When two hold a skill of the same name, the higher linked
                                    folder's copy is used, and the app workspace's comes last.
                                </PageHead>
                                <div className="set-group">
                                    {linkedFolders.length === 0 && (
                                        <div className="set-empty">
                                            No folders linked. Link one, such as <code>~/.claude/skills</code>, to use
                                            its skills where they are rather than copying them in.
                                        </div>
                                    )}
                                    {linkedFolders.map((folder, i) => {
                                        const shadowed = folder.skills.filter((s) => s.shadowed).map((s) => s.name);
                                        const count = folder.skills.length - shadowed.length;
                                        return (
                                            <Row
                                                key={folder.path}
                                                label={<span className="mono path">{folder.path}</span>}
                                                description={
                                                    folder.missing ? (
                                                        <span className="set-warn">
                                                            Not there. Its skills are not offered until it is back.
                                                        </span>
                                                    ) : (
                                                        <>
                                                            {count} skill{count === 1 ? '' : 's'}
                                                            {shadowed.length > 0 &&
                                                                ` · Hidden by a folder above: ${shadowed.join(', ')}`}
                                                        </>
                                                    )
                                                }
                                                control={
                                                    <>
                                                        <button
                                                            className="ghost"
                                                            aria-label={`Move ${folder.path} up`}
                                                            title="Move up"
                                                            disabled={i === 0}
                                                            onClick={() => void moveFolder(i, i - 1)}
                                                        >
                                                            ↑
                                                        </button>
                                                        <button
                                                            className="ghost"
                                                            aria-label={`Move ${folder.path} down`}
                                                            title="Move down"
                                                            disabled={i === linkedFolders.length - 1}
                                                            onClick={() => void moveFolder(i, i + 1)}
                                                        >
                                                            ↓
                                                        </button>
                                                        <button
                                                            disabled={folder.missing}
                                                            onClick={() => void revealFolder(folder.path)}
                                                        >
                                                            Show
                                                        </button>
                                                        <button
                                                            className="ghost danger"
                                                            title="Stop reading this folder. Nothing in it is deleted."
                                                            onClick={() =>
                                                                void changeFolders(
                                                                    linkedPaths.filter((p) => p !== folder.path),
                                                                    `Unlinked ${folder.path}. Its files are untouched.`,
                                                                )
                                                            }
                                                        >
                                                            Unlink
                                                        </button>
                                                    </>
                                                }
                                            />
                                        );
                                    })}
                                </div>
                                <div className="set-actions">
                                    <button
                                        onClick={() => void linkFolder()}
                                        title="Use a folder of skills where it is: changes there show up here"
                                    >
                                        Link folder…
                                    </button>
                                    <button
                                        onClick={() => void importSkills()}
                                        title="Copy the skills of chosen SKILL.md files into the app workspace, replacing any of the same name"
                                    >
                                        Import…
                                    </button>
                                </div>

                                {skillsMessage && (
                                    <div className={`set-message ${skillsMessage.bad ? 'err-banner' : 'notice'}`}>
                                        {skillsMessage.text}
                                    </div>
                                )}

                                <div className="set-subhead">
                                    {shelfSkills.length} skill{shelfSkills.length === 1 ? '' : 's'} on the shelf
                                </div>
                                <div className="set-group">
                                    {shelfSkills.length === 0 && (
                                        <div className="set-empty">No global skills yet.</div>
                                    )}
                                    {shelfSkills.map((skill) => (
                                        <Row
                                            key={skill.name}
                                            label={<span className="mono">{skill.name}</span>}
                                            description={
                                                <>
                                                    {skill.description || 'No description.'}
                                                    {folders.length > 1 && (
                                                        <span className="set-from">
                                                            {skill.folder === workspacePath ? 'App workspace' : skill.folder}
                                                        </span>
                                                    )}
                                                </>
                                            }
                                            control={
                                                <>
                                                    <button
                                                        aria-label={`Edit ${skill.name}`}
                                                        title="Open its SKILL.md in the app your system opens .md files with"
                                                        onClick={() => void editSkill(skill)}
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        className="ghost danger"
                                                        aria-label={`Delete ${skill.name}`}
                                                        onClick={() => setDeleting(skill)}
                                                    >
                                                        Delete
                                                    </button>
                                                </>
                                            }
                                        />
                                    ))}
                                </div>

                                {deleting && (
                                    <ConfirmDialog
                                        title="Delete skill"
                                        message={deleteQuestion(deleting)}
                                        confirmLabel="Delete"
                                        onCancel={() => setDeleting(null)}
                                        onConfirm={() => {
                                            void deleteSkill(deleting);
                                            setDeleting(null);
                                        }}
                                    />
                                )}

                                <div className="set-subhead">Seeding</div>
                                <div className="set-group">
                                    <Row
                                        label="Seed the global library from"
                                        description={
                                            <>
                                                A folder of <code>&lt;name&gt;/SKILL.md</code> folders, copied
                                                into the app workspace once while the shelf is empty.
                                            </>
                                        }
                                        below={
                                            <input
                                                className="mono"
                                                aria-label="Seed the global library from"
                                                value={draft.skillSeedPath}
                                                placeholder="Found automatically"
                                                onChange={(e) => patch({ skillSeedPath: e.target.value })}
                                            />
                                        }
                                    />
                                </div>
                                <p className="set-note">
                                    Linking, unlinking and reordering take effect at once, and unlinking deletes
                                    nothing. Import copies skills in, replacing the copy in use of any skill with the
                                    same name. Edit opens a skill in the app your system gives .md files, and what you
                                    change or delete in these folders shows here as it happens. To write a new skill,
                                    use the skill list in a canvas's inspector.
                                </p>
                            </>
                        )}

                        {page === 'runs' && (
                            <>
                                <PageHead title="Runs">
                                    Whether flows watch their mailboxes, and how much they may do at once.
                                </PageHead>
                                <div className="set-group">
                                    <Row
                                        label="Watch mailboxes"
                                        description="Lets flows check the Outlook folders their triggers name. While it's off, Start watching is refused; test runs still work."
                                        control={
                                            <Switch
                                                on={draft.pollingEnabled}
                                                label="Watch mailboxes"
                                                onChange={(on) => patch({ pollingEnabled: on })}
                                            />
                                        }
                                    />
                                    <Row
                                        label="Runs at once"
                                        description="Runs of different flows overlap; one flow still takes its own mail one email at a time. Outlook answers one call at a time, so past a few this mostly helps flows that are waiting on Claude."
                                        below={
                                            <div className="segmented" role="radiogroup" aria-label="Runs at once">
                                                {RUN_COUNTS.map((n) => (
                                                    <button
                                                        key={n}
                                                        role="radio"
                                                        aria-checked={draft.maxConcurrentRuns === n}
                                                        onClick={() => patch({ maxConcurrentRuns: n })}
                                                    >
                                                        {n}
                                                    </button>
                                                ))}
                                            </div>
                                        }
                                    />
                                </div>
                            </>
                        )}

                        {page === 'servers' && (
                            <>
                                <PageHead title="MCP servers">
                                    Tool servers handed to every Processor node — another app's MCP server whose
                                    tools your skills call, for example.
                                </PageHead>
                                <div className="set-group">
                                    {draft.mcpServers.length === 0 && (
                                        <div className="set-empty">
                                            No servers yet. Add one and every Processor node can call its tools.
                                        </div>
                                    )}
                                    {draft.mcpServers.map((server, i) => (
                                        <div key={i} className="set-row server">
                                            <div>
                                                <input
                                                    className="server-name"
                                                    aria-label="Server name"
                                                    placeholder="Name"
                                                    value={server.name}
                                                    onChange={(e) => patchServer(i, { name: e.target.value })}
                                                />
                                                <div className="set-desc">
                                                    Its tools arrive as{' '}
                                                    <code>mcp__{server.name.trim() || 'name'}__*</code>
                                                </div>
                                            </div>
                                            <div className="set-control">
                                                <Switch
                                                    on={server.enabled}
                                                    label={`Use ${server.name || 'this server'}`}
                                                    onChange={(on) => patchServer(i, { enabled: on })}
                                                />
                                                <button className="ghost danger" onClick={() => removeServer(i)}>
                                                    Remove
                                                </button>
                                            </div>
                                            <div className="set-below server-command">
                                                <label>
                                                    <span>Command</span>
                                                    <input
                                                        className="mono"
                                                        placeholder="node"
                                                        value={server.command}
                                                        onChange={(e) => patchServer(i, { command: e.target.value })}
                                                    />
                                                </label>
                                                <label>
                                                    <span>Arguments</span>
                                                    <input
                                                        className="mono"
                                                        placeholder="path/to/server.js --flag"
                                                        value={server.args.join(' ')}
                                                        onChange={(e) =>
                                                            patchServer(i, { args: e.target.value.split(' ').filter(Boolean) })
                                                        }
                                                    />
                                                </label>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <button className="set-add" onClick={addServer}>
                                    Add server
                                </button>
                            </>
                        )}

                        {page === 'agent' && (
                            <>
                                <PageHead title="Agent control">
                                    Patchbay's own MCP server, for Claude Code or another agent to drive this app:
                                    read your flows, wire nodes, write skills and start test runs. It only listens
                                    on this computer, and every request has to carry the token.
                                </PageHead>
                                <div className="set-group">
                                    <Row
                                        label="Let an agent drive this app"
                                        description={
                                            draft.agentControl.enabled !== settings.agentControl.enabled
                                                ? `Save changes to ${draft.agentControl.enabled ? 'start' : 'stop'} the server.`
                                                : settings.agentControl.enabled
                                                    ? 'Anything holding the token below can connect.'
                                                    : "Nothing can connect while it's off."
                                        }
                                        control={
                                            <Switch
                                                on={draft.agentControl.enabled}
                                                label="Let an agent drive this app"
                                                onChange={(on) => patchAgent({ enabled: on })}
                                            />
                                        }
                                    />
                                    <Row
                                        label="Port"
                                        description="Change it if something else on this computer already uses it. Saving moves the server over."
                                        control={
                                            <input
                                                className="port"
                                                type="number"
                                                aria-label="Port"
                                                min={1024}
                                                max={65535}
                                                value={draft.agentControl.port}
                                                onChange={(e) => patchAgent({ port: Number(e.target.value) })}
                                            />
                                        }
                                    />
                                </div>

                                {settings.agentControl.enabled && (
                                    <div className="conn">
                                        <div
                                            className={`conn-status${
                                                agentControl?.running ? ' live' : agentControl?.lastError ? ' err' : ''
                                            }`}
                                        >
                                            <span className={`dot${agentControl?.running ? ' live' : ''}`}/>
                                            {agentControl?.running ? (
                                                <>
                                                    <span>
                                                        Listening at <span
                                                        className="conn-url">{agentControl.url}</span>
                                                    </span>
                                                    <span className="spacer"/>
                                                    <span className="conn-when">
                                                        {agentControl.lastRequestAt
                                                            ? `Last call ${time(agentControl.lastRequestAt)}`
                                                            : 'No calls yet'}
                                                    </span>
                                                </>
                                            ) : (
                                                <span>
                                                    Not listening
                                                    {agentControl?.lastError ? `. ${agentControl.lastError}` : ' yet.'}
                                                </span>
                                            )}
                                        </div>

                                        {agentControl?.running && (
                                            <>
                                                <div className="conn-label">Add this install to Claude Code</div>
                                                <pre className="conn-command">
                                                    <span className="cmd">claude mcp add</span>{' '}
                                                    <span className="flag">--transport</span> http patchbay{' '}
                                                    <span className="arg">{agentControl.url}</span>{' '}
                                                    <span className="flag">--header</span> "Authorization: Bearer{' '}
                                                    <span className="arg">
                                                        {revealToken ? agentControl.token : '•'.repeat(16)}
                                                    </span>
                                                    "
                                                </pre>
                                                <div className="conn-actions">
                                                    <button
                                                        onClick={() => copy('command', connectCommand(agentControl))}>
                                                        {copied === 'command' ? 'Copied' : 'Copy command'}
                                                    </button>
                                                    <button onClick={() => copy('url', agentControl.url)}>
                                                        {copied === 'url' ? 'Copied' : 'Copy URL'}
                                                    </button>
                                                    <button onClick={() => setRevealToken(!revealToken)}>
                                                        {revealToken ? 'Hide token' : 'Show token'}
                                                    </button>
                                                    <span className="spacer"/>
                                                    <button
                                                        className="danger"
                                                        title="Mint a new token. Any agent still holding the old one is cut off."
                                                        onClick={onRegenerateToken}
                                                    >
                                                        New token
                                                    </button>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                )}

                                <p className="set-note">
                                    Its tools arrive as <code>mcp__patchbay__*</code>. None of them reads a message
                                    from your mailbox or sends mail: an agent picks an email to test against, and the
                                    run's own tools do the reading.
                                </p>
                            </>
                        )}
                    </div>
                </div>

                <div className="set-foot">
                    {dirty ? (
                        <span className="state">
                            <span className="edited"/>
                            Unsaved changes
                        </span>
                    ) : (
                        justSaved && <span className="state saved">Changes saved</span>
                    )}
                    <span className="spacer"/>
                    <button disabled={!dirty} onClick={() => setDraft(settings)}>
                        Discard
                    </button>
                    <button className="primary" title="Ctrl+S" disabled={!dirty} onClick={() => onSave(draft)}>
                        Save changes
                    </button>
                </div>
            </div>
        </div>
    );
}
