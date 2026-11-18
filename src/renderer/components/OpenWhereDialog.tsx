import type { JSX } from 'react';
import type { OpenWhere } from '@shared/ipc';
import { Modal } from './Modal';

/** Which canvas a flow opens on: asked only when a canvas is up showing a different flow. */
interface Props {
    /** The flow being opened. */
    name: string;
    /** The flow on the canvas that would give up its window. */
    current: string;

    onCancel(): void;

    onChoose(where: OpenWhere): void;
}

export function OpenWhereDialog({name, current, onCancel, onChoose}: Props): JSX.Element {
    return (
        <Modal
            title={`Open “${name}”`}
            onClose={onCancel}
            footer={
                <>
                    <button onClick={onCancel}>Cancel</button>
                    <button onClick={() => onChoose('current')}>In that window</button>
                    {/* The new window takes the focus, so a reflexive Enter never replaces a canvas. */}
                    <button autoFocus className="primary" onClick={() => onChoose('new')}>
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
