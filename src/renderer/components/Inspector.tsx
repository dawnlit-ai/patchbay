import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import {
  NODE_KIND_META,
  type Category,
  type FlowNode,
  type NodeConfig,
  type EffortLevel,
} from '@shared/flow';
import type { InboxFolderOption } from '@shared/ipc';
import type { SkillSummary } from '@shared/settings';

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

interface Props {
  node: FlowNode | null;
  skills: SkillSummary[];
  onChange(node: FlowNode): void;
  onDelete(nodeId: string): void;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </label>
  );
}

export function Inspector({ node, skills, onChange, onDelete }: Props): JSX.Element {
  const [accounts, setAccounts] = useState<string[]>([]);
  const [folders, setFolders] = useState<InboxFolderOption[]>([]);
  const [loadingMailbox, setLoadingMailbox] = useState(false);
  const [mailboxError, setMailboxError] = useState<string | null>(null);

  const isTrigger = node?.config.kind === 'trigger.outlook';
  const account = node?.config.kind === 'trigger.outlook' ? node.config.account : '';

  // Reading the mailbox drives Outlook over COM and takes a moment, so it only
  // happens while a trigger node is actually open in the inspector.
  useEffect(() => {
    if (!isTrigger) return;
    let cancelled = false;
    setLoadingMailbox(true);
    setMailboxError(null);
    window.api.outlook
      .accounts()
      .then((list) => {
        if (!cancelled) setAccounts(list);
      })
      .catch((e: Error) => {
        if (!cancelled) setMailboxError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingMailbox(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isTrigger]);

  useEffect(() => {
    if (!isTrigger || !account) {
      setFolders([]);
      return;
    }
    let cancelled = false;
    window.api.outlook
      .folders(account)
      .then((list) => {
        if (!cancelled) setFolders(list);
      })
      .catch((e: Error) => {
        if (!cancelled) setMailboxError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [isTrigger, account]);

  if (!node) {
    return (
      <div className="empty">
        Select a node to configure it, or drag one in from the palette on the left.
      </div>
    );
  }

  const meta = NODE_KIND_META[node.kind];
  const patch = (config: Partial<NodeConfig>): void =>
    onChange({ ...node, config: { ...node.config, ...config } as NodeConfig });

  return (
    <div>
      <div className={`section-title accented ${meta.slug}`}>{meta.label}</div>

      <Field label="Name">
        <input value={node.name} onChange={(e) => onChange({ ...node, name: e.target.value })} />
      </Field>

      {mailboxError && <div className="err-banner">{mailboxError}</div>}

      {node.config.kind === 'trigger.outlook' && (
        <>
          <Field
            label="Mailbox"
            hint={loadingMailbox ? 'Asking Outlook…' : 'Accounts come from the Outlook client on this machine.'}
          >
            <select value={node.config.account} onChange={(e) => patch({ account: e.target.value })}>
              <option value="">— choose an account —</option>
              {accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Folder" hint="Inbox subfolder to watch. Leave on Inbox to watch everything.">
            <select value={node.config.folder} onChange={(e) => patch({ folder: e.target.value })}>
              {folders.length === 0 && <option value="">Inbox</option>}
              {folders.map((f) => (
                <option key={f.folderPath || 'inbox'} value={f.relativePath}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="row">
            <Field label="Poll every (s)">
              <input
                type="number"
                min={15}
                value={node.config.pollSeconds}
                onChange={(e) => patch({ pollSeconds: Math.max(15, Number(e.target.value) || 60) })}
              />
            </Field>
            <Field label="Look back (days)">
              <input
                type="number"
                min={0}
                value={node.config.lookbackDays}
                onChange={(e) => patch({ lookbackDays: Math.max(0, Number(e.target.value) || 1) })}
              />
            </Field>
            <Field label="Max / poll">
              <input
                type="number"
                min={1}
                value={node.config.maxPerPoll}
                onChange={(e) => patch({ maxPerPoll: Math.max(1, Number(e.target.value) || 10) })}
              />
            </Field>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={node.config.processBacklogOnStart}
              onChange={(e) => patch({ processBacklogOnStart: e.target.checked })}
            />
            Process mail already in the folder when watching starts
          </label>
        </>
      )}

      {node.config.kind === 'categorizer' && (
        <>
          <Field
            label="Categories"
            hint="Claude picks one branch by matching the email against these descriptions. Write them the way you would explain the difference to a new colleague."
          >
            <div />
          </Field>

          {node.config.categories.map((cat, i) => (
            <div
              key={cat.id}
            className="card"
            >
              <div className="row" style={{ marginBottom: 6 }}>
                <input
                  value={cat.label}
                  placeholder="Label"
                  onChange={(e) => {
                    const categories = [...(node.config as { categories: Category[] }).categories];
                    categories[i] = { ...cat, label: e.target.value };
                    patch({ categories });
                  }}
                />
                <button
                  className="danger"
                  style={{ flex: 'none' }}
                  onClick={() =>
                    patch({
                      categories: (node.config as { categories: Category[] }).categories.filter(
                        (_, j) => j !== i,
                      ),
                    })
                  }
                >
                  Remove
                </button>
              </div>
              <textarea
                rows={3}
                placeholder="Which emails belong in this branch?"
                value={cat.description}
                onChange={(e) => {
                  const categories = [...(node.config as { categories: Category[] }).categories];
                  categories[i] = { ...cat, description: e.target.value };
                  patch({ categories });
                }}
              />
            </div>
          ))}

          <button
            onClick={() => {
              const categories = [...(node.config as { categories: Category[] }).categories];
              categories.push({
                id: Math.random().toString(36).slice(2, 8),
                label: 'New category',
                description: '',
              });
              patch({ categories });
            }}
          >
            + Add category
          </button>

          <div style={{ height: 12 }} />

          <Field label="Model">
            <select value={node.config.model} onChange={(e) => patch({ model: e.target.value })}>
              {MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>

          <label className="check">
            <input
              type="checkbox"
              checked={node.config.includeBody}
              onChange={(e) => patch({ includeBody: e.target.checked })}
            />
            Read the full body before classifying
          </label>

          {node.config.includeBody && (
            <Field label="Body characters">
              <input
                type="number"
                min={500}
                value={node.config.bodyMaxChars}
                onChange={(e) => patch({ bodyMaxChars: Math.max(500, Number(e.target.value) || 8000) })}
              />
            </Field>
          )}
        </>
      )}

      {node.config.kind === 'processor' && (
        <>
          <Field
            label="Skills"
            hint={
              skills.length === 0
                ? 'No skills in the library yet — add one on the Skills tab.'
                : 'Claude may invoke any skill you tick, and nothing else.'
            }
          >
            <div />
          </Field>
          {skills.map((skill) => {
            const config = node.config as { skills: string[] };
            const on = config.skills.includes(skill.name);
            return (
              <label className="check" key={skill.name} title={skill.description}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    patch({
                      skills: e.target.checked
                        ? [...config.skills, skill.name]
                        : config.skills.filter((s) => s !== skill.name),
                    })
                  }
                />
                {skill.name}
              </label>
            );
          })}

          <div style={{ height: 8 }} />

          <Field label="Instruction" hint="Prepended to the email. Say what a good outcome looks like.">
            <textarea
              rows={5}
              value={node.config.instruction}
              onChange={(e) => patch({ instruction: e.target.value })}
            />
          </Field>

          <div className="row">
            <Field label="Model">
              <select value={node.config.model} onChange={(e) => patch({ model: e.target.value })}>
                {MODELS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="Effort">
              <select
                value={node.config.effort}
                onChange={(e) => patch({ effort: e.target.value as EffortLevel })}
              >
                {EFFORTS.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="row">
            <Field label="Max turns">
              <input
                type="number"
                min={1}
                value={node.config.maxTurns}
                onChange={(e) => patch({ maxTurns: Math.max(1, Number(e.target.value) || 40) })}
              />
            </Field>
            <Field label="Budget (USD)">
              <input
                type="number"
                min={0}
                step={0.5}
                value={node.config.maxBudgetUsd}
                onChange={(e) => patch({ maxBudgetUsd: Math.max(0, Number(e.target.value) || 0) })}
              />
            </Field>
          </div>

          <div className="section-title">What this node may do</div>
          <label className="check">
            <input
              type="checkbox"
              checked={node.config.allowSaveAttachments}
              onChange={(e) => patch({ allowSaveAttachments: e.target.checked })}
            />
            Save attachments to the run folder
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={node.config.allowFileSystem}
              onChange={(e) => patch({ allowFileSystem: e.target.checked })}
            />
            Read and write files (Read, Write, Edit, Bash)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={node.config.allowDraftReply}
              onChange={(e) => patch({ allowDraftReply: e.target.checked })}
            />
            Leave a reply as an unsent draft
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={node.config.allowMoveEmail}
              onChange={(e) => patch({ allowMoveEmail: e.target.checked })}
            />
            Move the email to another folder
          </label>
          <div className="hint" style={{ color: 'var(--dim)' }}>
            Nothing here can send mail. A drafted reply waits in Outlook for a person.
          </div>
        </>
      )}

      {node.config.kind === 'terminal' && (
        <>
          <Field label="Disposition" hint="Recorded on the run, and shown in the runs list.">
            <select
              value={node.config.disposition}
              onChange={(e) =>
                patch({ disposition: e.target.value as 'done' | 'needs-review' | 'ignored' | 'failed' })
              }
            >
              <option value="done">done</option>
              <option value="needs-review">needs-review</option>
              <option value="ignored">ignored</option>
              <option value="failed">failed</option>
            </select>
          </Field>
          <Field
            label="File into folder"
            hint="Inbox subfolder, e.g. Processed/Pre-Alerts. Leave blank to leave the email where it is."
          >
            <input
              value={node.config.moveToFolder}
              placeholder="(leave in place)"
              onChange={(e) => patch({ moveToFolder: e.target.value })}
            />
          </Field>
        </>
      )}

      {node.kind !== 'trigger.outlook' && (
        <>
          <div style={{ height: 14 }} />
          <button className="danger" onClick={() => onDelete(node.id)}>
            Delete node
          </button>
        </>
      )}
    </div>
  );
}
