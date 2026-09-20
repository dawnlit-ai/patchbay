import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';

/** Asks for one line of text — every name the app asks for comes through here. */

interface Props {
    title: string;
    label: string;
    initial: string;
    confirmLabel: string;
    /** Shown under the input: what the name has to look like, when that matters. */
    hint?: string;

    onCancel(): void;

    onConfirm(value: string): void;
}

export function NameDialog({ title, label, initial, confirmLabel, hint, onCancel, onConfirm }: Props): JSX.Element {
    const [value, setValue] = useState(initial);
    const input = useRef<HTMLInputElement>(null);

    // Selected rather than merely focused: the common case is replacing the
    // suggestion outright, and the less common one is a click away.
    useEffect(() => {
        input.current?.select();
    }, []);

    const trimmed = value.trim();
    const submit = (): void => {
        if (trimmed) onConfirm(trimmed);
    };

    return (
        <Modal
            title={title}
            onClose={onCancel}
            footer={
                <>
                    <button onClick={onCancel}>Cancel</button>
                    <button className="primary" disabled={!trimmed} onClick={submit}>
                        {confirmLabel}
                    </button>
                </>
            }
        >
            <label className="field">
                <span>{label}</span>
                <input
                    ref={input}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') submit();
                    }}
                />
                {hint && <div className="hint">{hint}</div>}
            </label>
        </Modal>
    );
}
