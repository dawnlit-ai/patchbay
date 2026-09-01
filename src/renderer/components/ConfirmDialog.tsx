import type { JSX } from 'react';
import { useEffect, useRef } from 'react';

/**
 * Asks a yes/no question. Electron's own `window.confirm` is why this exists: it
 * shows the box correctly, but the page it belongs to cannot take focus again
 * afterwards — clicks land nowhere and a `select` refuses to open until the
 * window is left and returned to. So questions are asked in-app, as NameDialog
 * asks for names.
 */

/** A question on its own, so a caller can hold one and answer it later. */
export interface Question {
    title: string;
    message: string;
    confirmLabel: string;
}

interface Props extends Question {
    onCancel(): void;

    onConfirm(): void;
}

export function ConfirmDialog({ title, message, confirmLabel, onCancel, onConfirm }: Props): JSX.Element {
    const cancel = useRef<HTMLButtonElement>(null);

    // Cancel takes the focus, not the confirm: these questions guard something
    // irreversible, so a reflexive Enter should do nothing.
    useEffect(() => {
        cancel.current?.focus();
    }, []);

    return (
        <div className="modal-backdrop" onClick={onCancel}>
            <div
                className="modal narrow"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') onCancel();
                }}
            >
                <header>{title}</header>
                <div className="content">{message}</div>
                <footer>
                    <button ref={cancel} onClick={onCancel}>
                        Cancel
                    </button>
                    <button className="danger" onClick={onConfirm}>
                        {confirmLabel}
                    </button>
                </footer>
            </div>
        </div>
    );
}
