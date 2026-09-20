import type { JSX, ReactNode } from 'react';

/**
 * The frame every dialog shares: a scrim that dismisses on a click outside, a
 * panel that keeps the clicks inside it, and Escape from wherever the focus
 * happens to be.
 *
 * Dialogs are page elements rather than the browser's own. Electron implements
 * no `window.prompt` at all, and its `window.confirm` shows the box correctly
 * but leaves the page unable to take focus again afterwards — clicks land
 * nowhere and a `select` refuses to open until the window is left and returned
 * to.
 */

interface Props {
    /** The header row. A line of text in most, a line and a badge in some. */
    title: ReactNode;
    /** Wider, for a dialog holding a list rather than a question. */
    wide?: boolean;
    footer: ReactNode;
    children: ReactNode;

    onClose(): void;
}

export function Modal({ title, wide = false, footer, children, onClose }: Props): JSX.Element {
    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div
                className={wide ? 'modal' : 'modal narrow'}
                onClick={(e) => e.stopPropagation()}
                // Caught on the panel rather than on each field, so Escape closes
                // the dialog whatever inside it has the focus.
                onKeyDown={(e) => {
                    if (e.key === 'Escape') onClose();
                }}
            >
                <header>{title}</header>
                <div className="content">{children}</div>
                <footer>{footer}</footer>
            </div>
        </div>
    );
}
