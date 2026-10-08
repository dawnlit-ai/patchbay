import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { useState } from 'react';

/** Past this many, a group starts folded, scrolls inside itself when open, and the list gets a filter. */
const LONG_LIST = 8;

interface Props<T> extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children'> {
    title: string;
    /** The header's tooltip: what the group is. */
    tip?: string;
    items: T[];
    /** What the filter above the groups holds. While it holds anything, every group shows what it matches. */
    query: string;
    /** Controls at the end of the header, like New or Import…. */
    actions?: ReactNode;
    /** Said under the header, folded or not: the list is on its way, or could not be had. */
    note?: ReactNode;
    /** Said when open and holding nothing. */
    empty?: string;
    /** In place of the count, when it would mislead. */
    count?: string;

    /** Whether an item is ticked. Absent where nothing is, as for the skill libraries on their own. */
    isTicked?(item: T): boolean;

    /** The text the filter is matched against. */
    text(item: T): string;

    /** One item as a row, keyed. */
    row(item: T): ReactNode;
}

/**
 * A header that folds a list of tickable rows. Folded, it still shows what is
 * ticked, so a node's choices stay in sight however long the list it picks from.
 */
export function PickGroup<T>({
                                 title,
                                 tip,
                                 items,
                                 isTicked,
                                 query,
                                 text,
                                 row,
                                 actions,
                                 note,
                                 empty,
                                 count,
                                 className,
                                 ...rest
                             }: Props<T>): JSX.Element {
    /** Null until the header is clicked: a short group starts open, and a long one where ticks are picked, folded. */
    const [chosen, setChosen] = useState<boolean | null>(null);
    const open = chosen ?? (!isTicked || items.length <= LONG_LIST);
    const needle = query.trim().toLowerCase();

    const ticked = isTicked ? items.filter(isTicked) : [];
    let shown: T[];
    if (needle) shown = items.filter((item) => text(item).toLowerCase().includes(needle));
    else if (open) shown = items;
    else shown = ticked;

    return (
        <div className={`pick-group${className ? ` ${className}` : ''}`} {...rest}>
            <div className="pick-group-head">
                <button
                    className="pick-group-toggle"
                    title={tip}
                    aria-expanded={open}
                    onClick={() => setChosen(!open)}
                >
                    <span className="dim">{open ? '▾' : '▸'}</span>
                    <span className="pick-group-title">{title}</span>
                    <span className="pick-group-count">
                        {count ?? (isTicked ? `${ticked.length} of ${items.length}` : items.length)}
                    </span>
                </button>
                <span className="spacer"/>
                {actions}
            </div>

            {note && <div className="hint pick-note">{note}</div>}
            {!note && open && !needle && items.length === 0 && empty && (
                <div className="hint pick-note">{empty}</div>
            )}
            {needle && items.length > 0 && shown.length === 0 && <div className="hint pick-note">Nothing matches.</div>}

            {shown.length > 0 && (
                // Scrolls in place, so a long group never pushes the next one out of reach.
                <div className={shown.length > LONG_LIST ? 'pick-rows capped' : 'pick-rows'}>
                    {shown.map(row)}
                </div>
            )}
        </div>
    );
}

/** The one filter over a list's groups, shown once the list is long enough to need it. */
export function PickFilter({
                               value,
                               total,
                               noun,
                               onChange,
                           }: {
    value: string;
    total: number;
    noun: string;
    onChange(value: string): void;
}): JSX.Element | null {
    if (total <= LONG_LIST && value === '') return null;
    return (
        <input
            className="pick-filter"
            type="search"
            value={value}
            placeholder={`Filter ${total} ${noun}…`}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === 'Escape') onChange('');
            }}
        />
    );
}
