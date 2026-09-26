import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
    type AboutInfo,
    type AgentControlSettings,
    type AgentControlStatus,
    CONCURRENT_RUNS_RANGE,
    type McpServerSetting,
    type Settings,
} from '@shared/settings';
import { time } from '../format';

interface Props {
    settings: Settings;
    about: AboutInfo | null;
    /** What the agent-control server is actually doing, as opposed to what is asked of it. */
    agentControl: AgentControlStatus | null;

    onSave(settings: Settings): void;

    onRegenerateToken(): void;
}

/** The settings window's content: a rail of pages, the current page, and Save. */

type Page = 'claude' | 'runs' | 'servers' | 'agent';

const PAGES: { id: Page; label: string }[] = [
    { id: 'claude', label: 'Claude' },
    { id: 'runs', label: 'Runs' },
    { id: 'servers', label: 'MCP servers' },
    { id: 'agent', label: 'Agent control' },
];

/**
 * What each page edits, for marking unsaved pages. The token is left out: main
 * ignores it on save, so a stale copy here is not a change.
 */
const EDITS: Record<Page, (s: Settings) => unknown> = {
    claude: (s) => [s.claudeExecutablePath, s.skillSeedPath],
    runs: (s) => [s.pollingEnabled, s.maxConcurrentRuns],
    servers: (s) => s.mcpServers,
    agent: (s) => [s.agentControl.enabled, s.agentControl.port],
};

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
    const [page, setPage] = useState<Page>('claude');
    /** The token stays dotted out unless asked for: a settings window gets screen-shared. */
    const [revealToken, setRevealToken] = useState(false);
    /** Which copy button just put something on the clipboard. */
    const [copied, setCopied] = useState<string | null>(null);
    const [justSaved, setJustSaved] = useState(false);

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

    const patchAgent = (partial: Partial<AgentControlSettings>): void =>
        setDraft((d) => ({ ...d, agentControl: { ...d.agentControl, ...partial } }));

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
                        {page === 'claude' && (
                            <>
                                <PageHead title="Claude">
                                    Which Claude your Processor nodes run, and where the global skill library
                                    starts from.
                                </PageHead>
                                <div className="set-group">
                                    <Row
                                        label="Claude executable"
                                        description="Leave it blank to use Claude Code on this computer, or the copy that comes with the Agent SDK. Set a path only if Patchbay can't find either."
                                        below={
                                            <input
                                                className="mono"
                                                aria-label="Claude executable"
                                                value={draft.claudeExecutablePath}
                                                placeholder="Found automatically"
                                                onChange={(e) => patch({ claudeExecutablePath: e.target.value })}
                                            />
                                        }
                                    />
                                    <Row
                                        label="Seed the global library from"
                                        description={
                                            <>
                                                A folder of <code>&lt;name&gt;/SKILL.md</code> folders, copied in
                                                once while the global library is empty. To add skills later, use
                                                Import on a canvas's Skills tab.
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
