import type { JSX, ReactNode } from 'react';

/**
 * The frame every dialog shares; a click outside or Escape dismisses it. Dialogs
 * are page elements because Electron has no `window.prompt`, and `window.confirm`
 * leaves the page unable to take focus afterwards.
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

export function Modal({title, wide = false, footer, children, onClose}: Props): JSX.Element {
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
