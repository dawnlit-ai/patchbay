import type { JSX } from 'react';
import { useState } from 'react';
import type { AboutInfo, McpServerSetting, Settings } from '@shared/settings';

interface Props {
    settings: Settings;
    about: AboutInfo | null;

    onSave(settings: Settings): void;
}

export function SettingsPanel({ settings, about, onSave }: Props): JSX.Element {
    const [draft, setDraft] = useState<Settings>(settings);
    const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

    const patch = (partial: Partial<Settings>): void => setDraft({ ...draft, ...partial });

    const patchServer = (index: number, partial: Partial<McpServerSetting>): void =>
        patch({ mcpServers: draft.mcpServers.map((s, j) => (j === index ? { ...s, ...partial } : s)) });

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
                <span>Seed skills from</span>
                <input
                    value={draft.skillSeedPath}
                    placeholder="(auto-detect)"
                    onChange={(e) => patch({ skillSeedPath: e.target.value })}
                />
                <div className="hint">
                    A folder of <code>&lt;name&gt;/SKILL.md</code> directories, imported once when the library
                    is empty. Use Skills → Import… to pull more in at any time.
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

            <label className="check">
                <input
                    type="checkbox"
                    checked={draft.autoSaveFlows}
                    onChange={(e) => patch({ autoSaveFlows: e.target.checked })}
                />
                Save flow edits automatically
            </label>
            <div className="hint block">
                On, every change to the canvas is written straight away. Off, the topbar keeps a Save
                button and edits stay a draft until you press it — a running flow goes on using the last
                saved version.
            </div>

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
