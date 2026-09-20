import type { JSX } from 'react';
import { useEffect, useRef } from 'react';
import type { OpenWhere } from '@shared/ipc';
import { Modal } from './Modal';

/**
 * Which canvas a flow should open on. Asked only when there is something to
 * answer: a canvas is up, showing a different flow, and taking it over is as
 * likely to be wanted as drawing both at once. With no canvas open, or the flow
 * already on one, nothing is asked — there is one thing that can happen.
 */
interface Props {
    /** The flow being opened. */
    name: string;
    /** The flow on the canvas that would give up its window. */
    current: string;

    onCancel(): void;

    onChoose(where: OpenWhere): void;
}

export function OpenWhereDialog({ name, current, onCancel, onChoose }: Props): JSX.Element {
    const fresh = useRef<HTMLButtonElement>(null);

    // The new window takes the focus: it is the answer that leaves everything
    // already on screen where it is, so a reflexive Enter costs nobody their canvas.
    useEffect(() => {
        fresh.current?.focus();
    }, []);

    return (
        <Modal
            title={`Open “${name}”`}
            onClose={onCancel}
            footer={
                <>
                    <button onClick={onCancel}>Cancel</button>
                    <button onClick={() => onChoose('current')}>In that window</button>
                    <button ref={fresh} className="primary" onClick={() => onChoose('new')}>
                        In a new window
                    </button>
                </>
            }
        >
            “{current}” is on the canvas already. Open this flow in that window instead, or in a
            second one beside it? Both canvases watch the same workspace, and the runs and the
            console below each of them show all of it either way.
        </Modal>
    );
}
