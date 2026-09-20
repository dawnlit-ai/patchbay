import type { JSX } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The menu a right-click opens, drawn at the pointer. What can be done to one
 * thing belongs to that thing, so the actions live where the click landed
 * rather than in a strip that has to name which row it is talking about.
 *
 * It is a page element and not the system's own menu: Electron would have to
 * build that in the main process, one round trip away from the handlers and
 * the dialogs they open, for a menu that then cannot be themed with the rest
 * of the app.
 */

export interface MenuItem {
    label: string;
    /** A rule above this item, marking off the group it starts. */
    separator?: boolean;
    /** Destructive: coloured for it, as the Delete button was. */
    danger?: boolean;

    onSelect(): void;
}

interface Props {
    /** Where the click landed, in viewport coordinates. */
    x: number;
    y: number;
    items: MenuItem[];
    /** What the menu is acting on, read out for anyone not seeing the pointer. */
    label: string;

    onClose(): void;
}

export function ContextMenu({ x, y, items, label, onClose }: Props): JSX.Element {
    const menu = useRef<HTMLDivElement>(null);
    const buttons = useRef(new Map<number, HTMLButtonElement>());
    const [at, setAt] = useState<{ left: number; top: number } | null>(null);

    // Measured once it exists, then pulled back inside the window: a menu opened
    // near an edge flips to the other side of the pointer, as a system menu does.
    // Until that is worked out it is laid out but not painted, so it never shows
    // in one place and then jumps to another.
    useLayoutEffect(() => {
        const box = menu.current?.getBoundingClientRect();
        if (!box) return;
        const gap = 6;
        setAt({
            left: x + box.width + gap > window.innerWidth ? Math.max(gap, x - box.width) : x,
            top: y + box.height + gap > window.innerHeight ? Math.max(gap, y - box.height) : y,
        });
    }, [x, y]);

    // The first item takes the focus, so the menu answers the arrows and Enter
    // from the moment it opens. Once it is placed and not before: until then it
    // is hidden, and nothing hidden can be focused.
    useEffect(() => {
        if (at) buttons.current.get(0)?.focus();
    }, [at]);

    // Escape is caught for the whole window rather than the menu, so that it
    // closes whatever the click left focused — the row behind it, most often.
    // Anything that moves the window out from under the menu closes it too: it
    // would otherwise hang there pointing at nothing.
    useEffect(() => {
        const key = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            onClose();
        };
        window.addEventListener('keydown', key);
        window.addEventListener('blur', onClose);
        window.addEventListener('resize', onClose);
        return () => {
            window.removeEventListener('keydown', key);
            window.removeEventListener('blur', onClose);
            window.removeEventListener('resize', onClose);
        };
    }, [onClose]);

    const focusAt = (index: number): void => {
        const n = items.length;
        buttons.current.get(((index % n) + n) % n)?.focus();
    };

    return (
        <div
            className="menu-backdrop"
            // Down, not click: the press is what dismisses a menu, and the button
            // pressed away from it should not also act on whatever is underneath.
            onMouseDown={onClose}
            onWheel={onClose}
            onContextMenu={(e) => {
                e.preventDefault();
                onClose();
            }}
        >
            <div
                ref={menu}
                className="menu"
                role="menu"
                aria-label={label}
                style={{ left: at?.left ?? x, top: at?.top ?? y, visibility: at ? 'visible' : 'hidden' }}
                onMouseDown={(e) => e.stopPropagation()}
            >
                {items.map((item, index) => (
                    <div key={item.label} role="none">
                        {item.separator && <div className="sep"/>}
                        <button
                            ref={(el) => {
                                if (el) buttons.current.set(index, el);
                                else buttons.current.delete(index);
                            }}
                            role="menuitem"
                            className={item.danger ? 'danger' : undefined}
                            onClick={() => {
                                // Closed first: what an item opens — a dialog, another
                                // window — should arrive to a screen the menu has left.
                                onClose();
                                item.onSelect();
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'ArrowDown') focusAt(index + 1);
                                else if (e.key === 'ArrowUp') focusAt(index - 1);
                                else if (e.key === 'Home') focusAt(0);
                                else if (e.key === 'End') focusAt(items.length - 1);
                                else return;
                                e.preventDefault();
                            }}
                        >
                            {item.label}
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
