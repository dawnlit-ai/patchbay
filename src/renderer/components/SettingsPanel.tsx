import type { JSX } from 'react';
import { useState } from 'react';
import type {
    AboutInfo,
    AgentControlSettings,
    AgentControlStatus,
    McpServerSetting,
    Settings,
} from '@shared/settings';

interface Props {
    settings: Settings;
    about: AboutInfo | null;
    /** What the agent-control server is actually doing, as opposed to what is asked of it. */
    agentControl: AgentControlStatus | null;

    onSave(settings: Settings): void;

    onRegenerateToken(): void;
}

/** What to paste into a terminal to point Claude Code at this install. */
function connectCommand(status: AgentControlStatus): string {
    return `claude mcp add --transport http patchbay ${status.url} --header "Authorization: Bearer ${status.token}"`;
}

export function SettingsPanel({
                                  settings,
                                  about,
                                  agentControl,
                                  onSave,
                                  onRegenerateToken,
                              }: Props): JSX.Element {
    const [draft, setDraft] = useState<Settings>(settings);
    const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

    const patch = (partial: Partial<Settings>): void => setDraft({ ...draft, ...partial });

    const patchServer = (index: number, partial: Partial<McpServerSetting>): void =>
        patch({ mcpServers: draft.mcpServers.map((s, j) => (j === index ? { ...s, ...partial } : s)) });

    const patchAgent = (partial: Partial<AgentControlSettings>): void =>
        patch({ agentControl: { ...draft.agentControl, ...partial } });

    const copy = (text: string): void => void window.api.copyText(text);

    return (
        <div>
            <div className="panel-head plain">
                <strong>Settings</strong>
                <span className="spacer"/>
                <button className="primary" disabled={!dirty} onClick={() => onSave(draft)}>
                    Save
                </button>
            </div>

            <label className="field">
                <span>Claude executable</span>
                <input
                    value={draft.claudeExecutablePath}
                    placeholder="(auto-detect)"
                    onChange={(e) => patch({ claudeExecutablePath: e.target.value })}
                />
                <div className="hint">
                    Leave blank to use the Claude Code install on this machine, or the Agent SDK’s own bundled
                    binary. Set it only if the app cannot find one.
                </div>
            </label>

            <label className="field">
                <span>Seed global skills from</span>
                <input
                    value={draft.skillSeedPath}
                    placeholder="(auto-detect)"
                    onChange={(e) => patch({ skillSeedPath: e.target.value })}
                />
                <div className="hint">
                    A folder of <code>&lt;name&gt;/SKILL.md</code> directories, imported once while the
                    global library is empty. Use Skills → Import… to pull more into either library at any
                    time.
                </div>
            </label>

            <label className="check">
                <input
                    type="checkbox"
                    checked={draft.pollingEnabled}
                    onChange={(e) => patch({ pollingEnabled: e.target.checked })}
                />
                Allow flows to watch mailboxes
            </label>

            <div className="section-title">MCP servers</div>
            <div className="hint block">
                Extra tool servers handed to every Processor node — for example the MCP server of another
                app whose tools your skills call.
            </div>

            {draft.mcpServers.map((server, i) => (
                <div key={i} className="card">
                    <div className="row">
                        <input
                            placeholder="name"
                            value={server.name}
                            onChange={(e) => patchServer(i, { name: e.target.value })}
                        />
                        <button
                            className="danger fixed"
                            onClick={() => patch({ mcpServers: draft.mcpServers.filter((_, j) => j !== i) })}
                        >
                            Remove
                        </button>
                    </div>
                    <input
                        placeholder="command, e.g. node"
                        value={server.command}
                        onChange={(e) => patchServer(i, { command: e.target.value })}
                    />
                    <input
                        placeholder="arguments, space separated"
                        value={server.args.join(' ')}
                        onChange={(e) => patchServer(i, { args: e.target.value.split(' ').filter(Boolean) })}
                    />
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={server.enabled}
                            onChange={(e) => patchServer(i, { enabled: e.target.checked })}
                        />
                        Enabled
                    </label>
                </div>
            ))}

            <button
                onClick={() =>
                    patch({
                        mcpServers: [...draft.mcpServers, { name: '', command: '', args: [], enabled: true }],
                    })
                }
            >
                + Add server
            </button>

            <div className="section-title">Agent control</div>
            <div className="hint block">
                Patchbay’s own MCP server — the one an agent connects <em>to</em>. Switch it on and Claude
                Code, or anything else speaking MCP, can read your flows, wire nodes, write skills and start
                a test run, through the same files this window edits. It listens on 127.0.0.1 only, and every
                request has to carry the token below.
            </div>

            <label className="check">
                <input
                    type="checkbox"
                    checked={draft.agentControl.enabled}
                    onChange={(e) => patchAgent({ enabled: e.target.checked })}
                />
                Let an agent drive this app
            </label>

            <label className="field">
                <span>Port</span>
                <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={draft.agentControl.port}
                    onChange={(e) => patchAgent({ port: Number(e.target.value) })}
                />
                <div className="hint">
                    Loopback only. Change it if something else on this machine already answers here — Save
                    moves the server across.
                </div>
            </label>

            {agentControl?.lastError && <div className="err-banner">{agentControl.lastError}</div>}

            {agentControl?.running && (
                <div className="card">
                    <div className="row">
                        <span className="badge ok fixed">Listening</span>
                        <span className="spacer"/>
                        {agentControl.lastRequestAt && (
                            <span className="hint fixed">
                                Last call {new Date(agentControl.lastRequestAt).toLocaleTimeString()}
                            </span>
                        )}
                    </div>
                    <div className="hint">Add this install to Claude Code:</div>
                    <div className="copyable">{connectCommand(agentControl)}</div>
                    <div className="row">
                        <button onClick={() => copy(connectCommand(agentControl))}>Copy command</button>
                        <button onClick={() => copy(agentControl.url)}>Copy URL</button>
                        <button
                            className="danger"
                            title="Mint a new token. Any agent still holding the old one is cut off."
                            onClick={onRegenerateToken}
                        >
                            New token
                        </button>
                    </div>
                    <div className="hint">
                        The tools arrive as <code>mcp__patchbay__*</code>. None of them reaches into your
                        mailbox for a message, and none sends mail — an agent picks an email to test against,
                        and the run’s own tools do the reading.
                    </div>
                </div>
            )}

            {dirty && draft.agentControl.enabled !== settings.agentControl.enabled && (
                <div className="hint block">Save to {draft.agentControl.enabled ? 'start' : 'stop'} it.</div>
            )}

            {about && (
                <>
                    <div className="section-title">About</div>
                    <div className="about">
                        <div className="title">
                            {about.name} <span className="version">{about.version}</span>
                        </div>
                        <div className="line">
                            Developed by <strong>{about.developer}</strong>
                        </div>
                        <div className="line">Licensed under {about.license}</div>
                        <button className="link" onClick={() => void window.api.openDeveloperSite()}>
                            {about.developerUrl}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
