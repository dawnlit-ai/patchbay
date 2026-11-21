import type { CSSProperties, HTMLAttributes, JSX, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A part of a window with a line along one edge that drags it wider or taller:
 * the palette, the inspector, the dock, a rail. It goes as far as the person
 * drags it. The only stop is FLOOR, on this side of the line and on the other
 * (whose `min-width` or `min-height` in the stylesheet says so), so neither part
 * vanishes and the line stays within reach.
 *
 * Until the line is dragged the pane keeps the size the stylesheet gives it;
 * a double-click on the line goes back to that. A size once dragged is kept per
 * machine, like the theme, so every window showing this pane opens at it.
 */

/** The pane's edge the line runs along. */
export type Edge = 'left' | 'right' | 'top' | 'bottom';

const KEY = 'patchbay.panes';

/** The least a pane, or the part across its line, is dragged down to. The stylesheet gives the far side the same. */
const FLOOR = 64;

/** How far an arrow key moves a focused line, and with Shift held. */
const STEP = 16;
const BIG_STEP = 64;

function readSizes(): Record<string, unknown> {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
        return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** The size kept for `name`; null where none is, or one is unusable. */
function readSize(name: string): number | null {
    const kept = readSizes()[name];
    return typeof kept === 'number' && Number.isFinite(kept) ? Math.max(FLOOR, kept) : null;
}

/** Null forgets it, so the pane goes back to its stylesheet size. */
function keepSize(name: string, size: number | null): void {
    try {
        const {[name]: _, ...rest} = readSizes();
        localStorage.setItem(KEY, JSON.stringify(size === null ? rest : {...rest, [name]: size}));
    } catch {
        // Storage refused: the pane holds its size until this window closes.
    }
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

interface Props extends Omit<HTMLAttributes<HTMLElement>, 'style' | 'children'> {
    /** What the size is kept under, shared by every window that shows this pane. */
    name: string;
    edge: Edge;
    /** What a screen reader calls the line. */
    label: string;
    /** The element the pane is, for one that is a landmark. */
    as?: 'div' | 'nav';
    /** False leaves the pane its stylesheet size with no line, as for the dock while it is folded away. */
    resizable?: boolean;
    children: ReactNode;
}

interface Drag {
    /** The pointer's position along the axis when the drag began, and the pane's size then. */
    from: number;
    start: number;
    lo: number;
    hi: number;
    /** Where the last move put it, which React may not have drawn yet. */
    last: number;
}

export function Pane({
                         name,
                         edge,
                         label,
                         as: Tag = 'div',
                         resizable = true,
                         className,
                         children,
                         ...rest
                     }: Props): JSX.Element {
    const [size, setSize] = useState<number | null>(() => readSize(name));
    const [dragging, setDragging] = useState(false);
    const box = useRef<HTMLElement | null>(null);
    const drag = useRef<Drag | null>(null);
    /** One function for the life of the pane, so a re-render each move does not detach and reattach it. */
    const setBox = useCallback((el: HTMLElement | null) => {
        box.current = el;
    }, []);

    const axis = edge === 'left' || edge === 'right' ? 'x' : 'y';
    /** Moving the line right or down grows a pane on that side of it. */
    const sign = edge === 'right' || edge === 'bottom' ? 1 : -1;
    const length = (el: Element): number => el.getBoundingClientRect()[axis === 'x' ? 'width' : 'height'];

    // A window torn down mid-drag would otherwise keep the drag's cursor on everything.
    useEffect(
        () => () => {
            if (drag.current) delete document.documentElement.dataset.resizing;
        },
        [],
    );

    /**
     * The pane's size now, and the least and most it can be: the most is all the
     * part across the line has, but its stylesheet minimum. Never less than its
     * size now, so a window already too narrow for both does not snap the pane smaller.
     */
    const room = (line: HTMLElement, pane: HTMLElement): { now: number; lo: number; hi: number } => {
        const now = length(pane);
        const across = sign > 0 ? line.nextElementSibling : line.previousElementSibling;
        if (!across) return {now, lo: FLOOR, hi: Infinity};
        const least = parseFloat(getComputedStyle(across)[axis === 'x' ? 'minWidth' : 'minHeight']) || 0;
        return {now, lo: FLOOR, hi: Math.max(FLOOR, now, now + length(across) - least)};
    };

    const begin = (e: PointerEvent<HTMLDivElement>): void => {
        if (e.button !== 0 || !box.current) return;
        const {now, lo, hi} = room(e.currentTarget, box.current);
        drag.current = {from: axis === 'x' ? e.clientX : e.clientY, start: now, lo, hi, last: now};
        e.currentTarget.setPointerCapture(e.pointerId);
        // The drag's cursor everywhere, and no text selected on the way.
        document.documentElement.dataset.resizing = axis;
        setDragging(true);
    };

    const move = (e: PointerEvent<HTMLDivElement>): void => {
        const d = drag.current;
        if (!d) return;
        const at = axis === 'x' ? e.clientX : e.clientY;
        d.last = Math.round(clamp(d.start + sign * (at - d.from), d.lo, d.hi));
        setSize(d.last);
    };

    /** On release, and when anything else takes the pointer away. A click that never moved keeps nothing. */
    const end = (): void => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        delete document.documentElement.dataset.resizing;
        setDragging(false);
        if (d.last !== d.start) keepSize(name, d.last);
    };

    const nudge = (e: KeyboardEvent<HTMLDivElement>): void => {
        const keys = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        const toward = keys.indexOf(e.key);
        if (toward < 0 || !box.current) return;
        e.preventDefault();
        const {now, lo, hi} = room(e.currentTarget, box.current);
        const step = (toward === 1 ? 1 : -1) * sign * (e.shiftKey ? BIG_STEP : STEP);
        const next = Math.round(clamp(now + step, lo, hi));
        setSize(next);
        keepSize(name, next);
    };

    const reset = (): void => {
        setSize(null);
        keepSize(name, null);
    };

    // The floor holds even before a drag, so a narrow window shrinks the pane no
    // further than the line could.
    const style: CSSProperties | undefined = resizable
        ? axis === 'x'
            ? {minWidth: FLOOR, width: size ?? undefined}
            : {minHeight: FLOOR, height: size ?? undefined}
        : undefined;

    const pane = (
        <Tag
            ref={setBox}
            className={className}
            style={style}
            {...rest}
        >
            {children}
        </Tag>
    );

    const line = resizable && (
        <div
            className={`divider ${axis} at-${edge}${dragging ? ' dragging' : ''}`}
            role="separator"
            aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
            aria-label={label}
            aria-valuemin={FLOOR}
            aria-valuenow={size ?? undefined}
            tabIndex={0}
            title="Drag to resize · double-click for the usual size"
            onPointerDown={begin}
            onPointerMove={move}
            onLostPointerCapture={end}
            onKeyDown={nudge}
            onDoubleClick={reset}
        />
    );

    return sign > 0 ? (
        <>
            {pane}
            {line}
        </>
    ) : (
        <>
            {line}
            {pane}
        </>
    );
}
