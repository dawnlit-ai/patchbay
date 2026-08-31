import type { JSX } from 'react';
import { useState } from 'react';
import type { Settings } from '@shared/settings';

interface Props {
  settings: Settings;
  onSave(settings: Settings): void;
}

export function SettingsPanel({ settings, onSave }: Props): JSX.Element {
  const [draft, setDraft] = useState<Settings>(settings);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const patch = (partial: Partial<Settings>): void => setDraft({ ...draft, ...partial });

  return (
    <div>
      <div className="panel-head" style={{ padding: '0 0 10px', position: 'static' }}>
        <strong>Settings</strong>
        <span className="spacer" />
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

      <label className="check">
        <input
          type="checkbox"
          checked={draft.pollingEnabled}
          onChange={(e) => patch({ pollingEnabled: e.target.checked })}
        />
        Allow flows to watch mailboxes
      </label>

      <div className="section-title">MCP servers</div>
      <div className="hint" style={{ color: 'var(--dim)', marginBottom: 8 }}>
        Extra tool servers handed to every Processor node — for example the MCP server of another
        app whose tools your skills call.
      </div>

      {draft.mcpServers.map((server, i) => (
        <div
          key={i}
          style={{
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: 9,
            marginBottom: 8,
            background: 'var(--panel-2)',
          }}
        >
          <div className="row" style={{ marginBottom: 6 }}>
            <input
              placeholder="name"
              value={server.name}
              onChange={(e) => {
                const mcpServers = [...draft.mcpServers];
                mcpServers[i] = { ...server, name: e.target.value };
                patch({ mcpServers });
              }}
            />
            <button
              className="danger"
              style={{ flex: 'none' }}
              onClick={() => patch({ mcpServers: draft.mcpServers.filter((_, j) => j !== i) })}
            >
              Remove
            </button>
          </div>
          <input
            placeholder="command, e.g. node"
            style={{ marginBottom: 6 }}
            value={server.command}
            onChange={(e) => {
              const mcpServers = [...draft.mcpServers];
              mcpServers[i] = { ...server, command: e.target.value };
              patch({ mcpServers });
            }}
          />
          <input
            placeholder="arguments, space separated"
            value={server.args.join(' ')}
            onChange={(e) => {
              const mcpServers = [...draft.mcpServers];
              mcpServers[i] = { ...server, args: e.target.value.split(' ').filter(Boolean) };
              patch({ mcpServers });
            }}
          />
          <label className="check" style={{ marginTop: 6, marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={server.enabled}
              onChange={(e) => {
                const mcpServers = [...draft.mcpServers];
                mcpServers[i] = { ...server, enabled: e.target.checked };
                patch({ mcpServers });
              }}
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
    </div>
  );
}
