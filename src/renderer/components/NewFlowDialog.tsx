import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { toFolderName } from '@shared/naming';
import { Modal } from './Modal';

/**
 * Name a new flow, or a copy of one, and choose where it is kept. It gets a folder
 * of its own inside the location, named after it, since that folder is what its
 * runs can read.
 */

interface Props {
    title?: string;
    initialName?: string;
    confirmLabel?: string;
    /** What else making it does, said after where it goes. */
    note?: string;

    onCancel(): void;

    onConfirm(name: string, location: string): void;
}

export function NewFlowDialog({
                                  title = 'New flow',
                                  initialName = 'New flow',
                                  confirmLabel = 'Create',
                                  note,
                                  onCancel,
                                  onConfirm,
                              }: Props): JSX.Element {
    const [name, setName] = useState(initialName);
    /** Null until main says which folder to offer. */
    const [location, setLocation] = useState<string | null>(null);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        input.current?.select();
        void window.api.flows.location().then((offered) => setLocation((typed) => typed ?? offered));
    }, []);

    const trimmed = name.trim();
    const where = (location ?? '').trim().replace(/[\\/]+$/, '');
    // Shown in the platform's own separator, which the offered path already uses.
    const separator = where.includes('\\') ? '\\' : '/';
    const ready = trimmed !== '' && where !== '';

    const submit = (): void => {
        if (ready) onConfirm(trimmed, where);
    };

    const onEnter = (e: { key: string }): void => {
        if (e.key === 'Enter') submit();
    };

    const browse = async (): Promise<void> => {
        const picked = await window.api.flows.pickLocation(where);
        if (picked) setLocation(picked);
    };

    return (
        <Modal
            title={title}
            onClose={onCancel}
            footer={
                <>
                    <button onClick={onCancel}>Cancel</button>
                    <button className="primary" disabled={!ready} onClick={submit}>
                        {confirmLabel}
                    </button>
                </>
            }
        >
            <label className="field">
                <span>Flow name</span>
                <input ref={input} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter}/>
            </label>

            <div className="field">
                <span>Location</span>
                <div className="row">
                    <input
                        value={location ?? ''}
                        placeholder="Loading…"
                        spellCheck={false}
                        onChange={(e) => setLocation(e.target.value)}
                        onKeyDown={onEnter}
                    />
                    <button className="fixed" onClick={() => void browse()}>
                        Browse…
                    </button>
                </div>
                {where !== '' && (
                    <div className="hint">
                        Makes <code>{`${where}${separator}${toFolderName(trimmed)}`}</code>, numbered if that is taken,
                        and saves the flow there as <code>flow.json</code>. Its runs work in that folder and its own
                        skills live in it.{note && ` ${note}`}
                    </div>
                )}
            </div>
        </Modal>
    );
}
