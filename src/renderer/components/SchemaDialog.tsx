import type { JSX } from 'react';
import { useState } from 'react';
import { type JsonSchema, SLOT_NAME } from '@shared/flow';
import { Modal } from './Modal';
import { SchemaEditor } from './SchemaEditor';

/**
 * Making or changing one of the workspace's named schemas, its name included,
 * without leaving the start window or writing JSON. Nothing is written until
 * Save, and a click outside asks before it throws edits away.
 */

const BLANK: JsonSchema = {type: 'object', properties: {}, required: []};

interface Props {
    /** The schema being changed, or null for a new one. */
    name: string | null;
    /** What a new one is called to begin with: a name some node already uses, say. */
    suggested?: string;
    schema?: JsonSchema;
    /** Every name the workspace's schemas folder holds, so one taken is caught before Save. */
    taken: string[];
    /** The ones a field can be: those a node can use. */
    named: string[];
    /** Who uses it now, said under its name. */
    usage?: string;

    onCancel(): void;

    /**
     * Write it: `schema` is null when only the name changed. Resolves to why it
     * could not be, or null once it is written and the dialog can go.
     */
    onSave(name: string, schema: JsonSchema | null): Promise<string | null>;

    onDelete?(): void;
}

export function SchemaDialog({
                                 name,
                                 suggested = '',
                                 schema,
                                 taken,
                                 named,
                                 usage,
                                 onCancel,
                                 onSave,
                                 onDelete,
                             }: Props): JSX.Element {
    const original = schema ?? BLANK;
    const [draftName, setDraftName] = useState(name ?? suggested);
    const [draft, setDraft] = useState<JsonSchema>(original);
    const [saving, setSaving] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    /** A click outside or Escape with edits made: asked about in the footer rather than lost. */
    const [leaving, setLeaving] = useState(false);

    const wanted = draftName.trim();
    const clash = taken.find((other) => other !== name && other.toLowerCase() === wanted.toLowerCase());
    const problem = !SLOT_NAME.test(wanted)
        ? 'Letters, digits and _ only, not starting with a digit.'
        : clash
            ? `This workspace already has a schema called ${clash}.`
            : null;
    const changed = JSON.stringify(draft) !== JSON.stringify(original);
    const dirty = changed || wanted !== (name ?? suggested);

    const save = async (): Promise<void> => {
        setSaving(true);
        setFailure(await onSave(wanted, name === null || changed ? draft : null));
        setSaving(false);
    };

    return (
        <Modal
            wide
            title={name === null ? 'New schema' : `Edit ${name}`}
            onClose={() => (dirty ? setLeaving(true) : onCancel())}
            footer={
                leaving ? (
                    <>
                        <span className="footer-note">Your changes have not been saved.</span>
                        <span className="spacer"/>
                        <button onClick={() => setLeaving(false)}>Keep editing</button>
                        <button className="danger" onClick={onCancel}>
                            Discard them
                        </button>
                    </>
                ) : (
                    <>
                        {onDelete && (
                            <button className="danger" onClick={onDelete}>
                                Delete…
                            </button>
                        )}
                        <span className="spacer"/>
                        <button onClick={onCancel}>Cancel</button>
                        <button className="primary" disabled={problem !== null || saving} onClick={() => void save()}>
                            {name === null ? 'Create' : 'Save'}
                        </button>
                    </>
                )
            }
        >
            {failure && <div className="err-banner">{failure}</div>}
            <label className="field">
                <span>Name</span>
                <input
                    value={draftName}
                    spellCheck={false}
                    autoFocus={name === null}
                    onChange={(e) => setDraftName(e.target.value)}
                />
                <div className="hint">
                    {problem ??
                        (name !== null && wanted !== name
                            ? `Renamed on Save, and every node and schema using ${name}, in every flow here, follows.`
                            : `Its file is schemas/${wanted}.json. Any Extractor or Processor in any flow here can pick it by this name.`)}
                </div>
            </label>
            {usage && <div className="hint block">{usage}</div>}
            <SchemaEditor
                value={draft}
                named={named.filter((other) => other !== name && other !== wanted)}
                hint="Give each field a description: it is what Claude reads to fill it. Required fields have to be filled for the step to pass."
                onChange={setDraft}
            />
        </Modal>
    );
}
