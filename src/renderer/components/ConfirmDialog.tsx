import type { JSX } from 'react';
import { useEffect, useRef } from 'react';
import { Modal } from './Modal';

/** Asks a yes/no question. A question on its own, so a caller can hold one and answer it later. */
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
        <Modal
            title={title}
            onClose={onCancel}
            footer={
                <>
                    <button ref={cancel} onClick={onCancel}>
                        Cancel
                    </button>
                    <button className="danger" onClick={onConfirm}>
                        {confirmLabel}
                    </button>
                </>
            }
        >
            {message}
        </Modal>
    );
}
