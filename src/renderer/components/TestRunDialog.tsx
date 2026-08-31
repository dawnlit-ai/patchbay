import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { Flow } from '@shared/flow';
import { findTrigger } from '@shared/flow';
import type { EmailEnvelope } from '@shared/trace';

/**
 * Push one real email through the flow on demand. This is how a flow gets built:
 * wire it up, run a message you already understand through it, read the trace,
 * adjust. It ignores the watermark, so the same email can be run repeatedly.
 */

interface Props {
  flow: Flow;
  onClose(): void;
  onRun(email: EmailEnvelope): void;
}

export function TestRunDialog({ flow, onClose, onRun }: Props): JSX.Element {
  const [emails, setEmails] = useState<EmailEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const trigger = findTrigger(flow);
  const config = trigger?.config.kind === 'trigger.outlook' ? trigger.config : null;

  useEffect(() => {
    if (!config?.account) {
      setError('Set a mailbox on the trigger node first.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    window.api.outlook
      .recent(config.account, config.folder, 25)
      .then((list) => {
        if (!cancelled) setEmails(list);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [config?.account, config?.folder]);

  const chosen = emails.find((e) => e.ref.entryId === selected);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          Test run — pick an email
          <span style={{ flex: 1 }} />
          <span className="badge">{flow.name}</span>
        </header>
        <div className="content">
          {loading && <div className="empty">Reading the mailbox…</div>}
          {error && <div className="err-banner">{error}</div>}
          {!loading && !error && emails.length === 0 && (
            <div className="empty">Nothing in that folder from the last 7 days.</div>
          )}
          {emails.map((email) => (
            <div
              key={email.ref.entryId}
              className={`list-row${selected === email.ref.entryId ? ' active' : ''}`}
              onClick={() => setSelected(email.ref.entryId)}
            >
              <div className="grow">
                <strong>{email.subject || '(no subject)'}</strong>
                <div className="desc">
                  {email.senderEmail} · {email.receivedTime}
                  {email.attachmentNames.length > 0 && ` · ${email.attachmentNames.length} file(s)`}
                </div>
              </div>
            </div>
          ))}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!chosen}
            onClick={() => {
              if (chosen) onRun(chosen);
            }}
          >
            Run this email
          </button>
        </footer>
      </div>
    </div>
  );
}
