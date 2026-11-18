import type { JSX, ReactNode } from 'react';
import { useState } from 'react';

/**
 * A line that a click opens to its detail, when it has one: a console entry, or
 * an event in a run's trace. `head` places the ▸ / ▾ it is handed.
 */
export function Expandable({className, detail, head}: {
    className: string;
    detail?: string;
    head(marker: ReactNode): ReactNode;
}): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
        <div className={className}>
            <div className={detail ? 'head expandable' : 'head'} onClick={() => detail && setOpen(!open)}>
                {head(detail && <span className="dim">{open ? '▾ ' : '▸ '}</span>)}
            </div>
            {open && detail && <pre>{detail}</pre>}
        </div>
    );
}
