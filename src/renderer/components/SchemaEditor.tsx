import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { JsonSchema } from '@shared/flow';
import {
    addField,
    describeField,
    fieldsOf,
    formable,
    isObject,
    type Kind,
    kindOf,
    KINDS,
    moveField,
    removeField,
    renameField,
    requiredOf,
    retype,
    setField,
    setRequired,
} from '../schemaShape';

/**
 * A schema edited as a list of fields, for someone who would rather not write
 * JSON: each a name, a kind, a description and whether it is required. A group
 * opens to its own fields. The JSON is a click away, for what the form has no
 * control for; a field the form cannot show is edited as JSON where it stands.
 */

interface Props {
    value: JsonSchema;
    /** The workspace's named schemas a field can be. Not the one being edited: a schema cannot hold itself. */
    named: string[];
    /** Under the editor: what the schema is for, or who else an edit reaches. */
    hint?: string;

    onChange(schema: JsonSchema): void;
}

export function SchemaEditor({value, named, hint, onChange}: Props): JSX.Element {
    const canForm = formable(value);
    const [view, setView] = useState<'fields' | 'json'>(canForm ? 'fields' : 'json');
    const shown = canForm ? view : 'json';
    const about = typeof value.description === 'string' ? value.description : '';

    return (
        <div className="schema-editor">
            <div className="segmented" role="radiogroup" aria-label="Edit as">
                <button
                    role="radio"
                    aria-checked={shown === 'fields'}
                    disabled={!canForm}
                    title={canForm ? undefined : 'This schema is more than a list of fields, so it is edited as JSON.'}
                    onClick={() => setView('fields')}
                >
                    Fields
                </button>
                <button role="radio" aria-checked={shown === 'json'} onClick={() => setView('json')}>
                    JSON
                </button>
            </div>

            {shown === 'fields' ? (
                <>
                    <textarea
                        className="prose"
                        rows={1}
                        placeholder="What this describes, for Claude (optional)"
                        value={about}
                        onChange={(e) => onChange(describeField(value, e.target.value))}
                    />
                    <FieldList schema={value} named={named} onChange={onChange}/>
                    {hint && <div className="hint">{hint}</div>}
                </>
            ) : (
                <SchemaText value={value} hint={hint ?? 'JSON Schema.'} onChange={onChange}/>
            )}
        </div>
    );
}

/** One object's fields, each a card, with a way to add another. */
function FieldList({schema, named, onChange}: {
    schema: JsonSchema;
    named: string[];
    onChange(schema: JsonSchema): void;
}): JSX.Element {
    const fields = fieldsOf(schema);
    const names = Object.keys(fields);
    const required = new Set(requiredOf(schema));
    // A card is known by an id of its own rather than its field's name, which a
    // rename changes: its state stays with it, and the control clicked next is
    // still there to take the click.
    const ids = useRef(new Map<string, number>());
    const minted = useRef(0);
    const idOf = (name: string): number => {
        let id = ids.current.get(name);
        if (id === undefined) {
            id = minted.current++;
            ids.current.set(name, id);
        }
        return id;
    };
    return (
        <div className="field-list">
            {names.length === 0 && <div className="hint block">No fields yet.</div>}
            {names.map((name, at) => (
                <FieldCard
                    key={idOf(name)}
                    name={name}
                    field={fields[name]}
                    required={required.has(name)}
                    siblings={names}
                    named={named}
                    first={at === 0}
                    last={at === names.length - 1}
                    onRename={(to) => {
                        ids.current.set(to, idOf(name));
                        ids.current.delete(name);
                        onChange(renameField(schema, name, to));
                    }}
                    onChange={(field) => onChange(setField(schema, name, field))}
                    onRequired={(on) => onChange(setRequired(schema, name, on))}
                    onMove={(by) => onChange(moveField(schema, name, by))}
                    onRemove={() => onChange(removeField(schema, name))}
                />
            ))}
            <button className="add-field" onClick={() => onChange(addField(schema))}>
                ＋ Add field
            </button>
        </div>
    );
}

function FieldCard({
                       name,
                       field,
                       required,
                       siblings,
                       named,
                       first,
                       last,
                       onRename,
                       onChange,
                       onRequired,
                       onMove,
                       onRemove,
                   }: {
    name: string;
    field: unknown;
    required: boolean;
    /** Every field's name at this level, its own included. */
    siblings: string[];
    named: string[];
    first: boolean;
    last: boolean;

    onRename(to: string): void;

    onChange(field: Record<string, unknown>): void;

    onRequired(on: boolean): void;

    onMove(by: number): void;

    onRemove(): void;
}): JSX.Element {
    // A draft, so a name half typed — or one another field has — is never written.
    const [draft, setDraft] = useState(name);
    const [open, setOpen] = useState(false);
    // Renamed from outside: in another window, or the JSON view.
    useEffect(() => setDraft(name), [name]);
    const f = isObject(field) ? field : {};
    const kind = kindOf(f);
    const wanted = draft.trim();
    const problem =
        wanted === ''
            ? 'A field needs a name.'
            : wanted !== name && siblings.includes(wanted)
                ? `There is already a field called ${wanted}.`
                : null;

    const commit = (): void => {
        if (problem || wanted === name) setDraft(name);
        else onRename(wanted);
    };

    // A group's fields, or the fields of each group a list holds.
    const nested = kind === 'object' ? f : kind === 'array' && kindOf(f.items) === 'object' ? (f.items as JsonSchema) : null;
    const count = nested ? Object.keys(fieldsOf(nested)).length : 0;

    return (
        <div className="field-card">
            <div className="field-head">
                <input
                    className="field-name"
                    value={draft}
                    aria-label="Field name"
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') setDraft(name);
                    }}
                />
                <KindPicker value={kind} named={named} onChange={(next) => onChange(retype(f, next))}/>
                {kind === 'array' && (
                    <>
                        <span className="of">of</span>
                        <KindPicker
                            value={kindOf(f.items)}
                            named={named}
                            items
                            onChange={(next) => onChange({...f, items: retype(f.items, next)})}
                        />
                    </>
                )}
                <span className="field-tools">
                    <button className="ghost icon" title="Move up" disabled={first} onClick={() => onMove(-1)}>
                        ↑
                    </button>
                    <button className="ghost icon" title="Move down" disabled={last} onClick={() => onMove(1)}>
                        ↓
                    </button>
                    <button className="ghost icon remove" title={`Remove ${name}`} onClick={onRemove}>
                        ✕
                    </button>
                </span>
            </div>
            {problem && <div className="hint err">{problem}</div>}

            <textarea
                className="prose"
                rows={1}
                placeholder="What goes here — Claude reads this to fill it"
                value={typeof f.description === 'string' ? f.description : ''}
                onChange={(e) => onChange(describeField(f, e.target.value))}
            />

            {kind === 'choice' && (
                <Choices values={f.enum as string[]} onChange={(values) => onChange({...f, enum: values})}/>
            )}
            {kind === 'custom' && (
                <SchemaText
                    value={f}
                    rows={5}
                    hint="More than the form can show, so this field is edited as JSON."
                    onChange={onChange}
                />
            )}

            <div className="field-foot">
                <label className="check">
                    <input type="checkbox" checked={required} onChange={(e) => onRequired(e.target.checked)}/>
                    Required
                </label>
                {nested && (
                    <button className="ghost compact" aria-expanded={open} onClick={() => setOpen(!open)}>
                        {open ? '▾' : '▸'} {count} field{count === 1 ? '' : 's'}
                        {kind === 'array' ? ' in each' : ''}
                    </button>
                )}
            </div>

            {nested && open && (
                <div className="field-nested">
                    <FieldList
                        schema={nested}
                        named={named}
                        onChange={(next) => onChange(kind === 'object' ? next : {...f, items: next})}
                    />
                </div>
            )}
        </div>
    );
}

function KindPicker({value, named, items = false, onChange}: {
    value: Kind;
    named: string[];
    /** What a list holds, rather than the field itself. */
    items?: boolean;

    onChange(kind: Kind): void;
}): JSX.Element {
    const missing = value.startsWith('ref:') && !named.includes(value.slice('ref:'.length));
    return (
        <select
            className="field-kind"
            value={value}
            aria-label={items ? 'What the list holds' : 'Kind'}
            onChange={(e) => onChange(e.target.value as Kind)}
        >
            {KINDS.map(({kind, label}) => (
                <option key={kind} value={kind}>
                    {label}
                </option>
            ))}
            {value === 'custom' && <option value="custom">Other (JSON)</option>}
            {(named.length > 0 || missing) && (
                <optgroup label="Named schemas">
                    {missing && <option value={value}>{value.slice('ref:'.length)} (missing)</option>}
                    {named.map((name) => (
                        <option key={name} value={`ref:${name}`}>
                            {name}
                        </option>
                    ))}
                </optgroup>
            )}
        </select>
    );
}

/** The values a choice may take, typed as a list. A draft, so a comma just typed is not lost to the tidy-up. */
function Choices({values, onChange}: { values: string[]; onChange(values: string[]): void }): JSX.Element {
    const [text, setText] = useState(values.join(', '));
    return (
        <label className="choices">
            <span>Choices</span>
            <input
                value={text}
                placeholder="flat, day, hour"
                spellCheck={false}
                onChange={(e) => {
                    setText(e.target.value);
                    onChange([...new Set(e.target.value.split(',').map((v) => v.trim()).filter(Boolean))]);
                }}
            />
        </label>
    );
}

/** A schema as JSON text. A draft, so text that does not parse yet is never saved over the last good schema. */
function SchemaText({value, hint, rows = 12, onChange}: {
    value: JsonSchema;
    hint: string;
    rows?: number;

    onChange(schema: JsonSchema): void;
}): JSX.Element {
    const [text, setText] = useState(() => JSON.stringify(value, null, 2));
    const [error, setError] = useState<string | null>(null);

    // Changed from outside — the form, or another window — while this one was not being typed in.
    useEffect(() => {
        if (error === null) setText((current) => (sameJson(current, value) ? current : JSON.stringify(value, null, 2)));
    }, [value, error]);

    const edit = (next: string): void => {
        setText(next);
        try {
            const parsed: unknown = JSON.parse(next);
            if (!isObject(parsed)) {
                setError('The schema has to be a JSON object.');
                return;
            }
            setError(null);
            onChange(parsed);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    return (
        <div className="field">
            <textarea rows={rows} spellCheck={false} value={text} onChange={(e) => edit(e.target.value)}/>
            <div className="hint">{error ?? hint}</div>
        </div>
    );
}

/** Whether `text` already says `value`, however it is laid out. */
function sameJson(text: string, value: unknown): boolean {
    try {
        return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
    } catch {
        return false;
    }
}
