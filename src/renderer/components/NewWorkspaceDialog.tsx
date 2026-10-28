import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { toFolderName } from '@shared/naming';
import { Modal } from './Modal';

/**
 * Name a new workspace and choose where it is kept. It gets a folder of its own
 * inside the location, named after it, since that folder is what its runs work in.
 */

interface Props {
    onCancel(): void;

    onConfirm(name: string, location: string): void;
}

export function NewWorkspaceDialog({onCancel, onConfirm}: Props): JSX.Element {
    const [name, setName] = useState('My workspace');
    /** Null until main says which folder to offer. */
    const [location, setLocation] = useState<string | null>(null);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        input.current?.select();
        void window.api.workspace.location().then((offered) => setLocation((typed) => typed ?? offered));
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
        const picked = await window.api.workspace.pickLocation(where);
        if (picked) setLocation(picked);
    };

    return (
        <Modal
            title="New workspace"
            onClose={onCancel}
            footer={
                <>
                    <button onClick={onCancel}>Cancel</button>
                    <button className="primary" disabled={!ready} onClick={submit}>
                        Create
                    </button>
                </>
            }
        >
            <label className="field">
                <span>Workspace name</span>
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
                        Makes <code>{`${where}${separator}${toFolderName(trimmed, 'workspace')}`}</code>, numbered if
                        that is taken. Its flows are kept in its <code>flows</code> folder, the skills and schemas they
                        share in <code>skills</code> and <code>schemas</code>, and every run works in it.
                    </div>
                )}
            </div>
        </Modal>
    );
}
