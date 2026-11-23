import { crc32, deflateSync } from 'node:zlib';

/**
 * The tray icon, drawn here rather than shipped as a file: Patchbay's "Quiet
 * Branch Fade" mark — one origin node splitting into an active upper branch and
 * a softly fading quiet branch, with the bottom-right node turning into the
 * status dot while flows are watched or running. Drawn afresh at each size a
 * screen's scaling asks for, so none is a blurred copy of another. Takes
 * nothing from Electron, so a script can draw it to look at.
 */

/** What the dot says: nothing watched, flows watched, or runs under way, waiting or under review. */
export type TrayState = 'idle' | 'watching' | 'busy';

interface Point {
    x: number;
    y: number;
}

/** The icon is laid out on a square this many points across, and drawn at that times the screen's scaling. */
export const ICON_POINTS = 16;

const ORIGIN: Point = {x: 3.1, y: 8.0};
const TOP_END: Point = {x: 12.6, y: 3.7};
const BOT_END: Point = {x: 12.6, y: 12.3};

const DOT_RADIUS = 2.15;
const ACTIVE_WIDTH = 1.85;
const QUIET_WIDTH = 1.45;
const QUIET_RING_OUTER = 2.05;
const QUIET_RING_INNER = 0.95;
/** When watching or busy, the bottom-right node lights up as a solid status dot. */
const STATUS_DOT_RADIUS = 2.55;

/** Cubic Bezier sampled into short straight segments, leaving each node horizontally. */
function curve(a: Point, b: Point): Point[] {
    const mid = (a.x + b.x) / 2;
    const p1: Point = {x: mid, y: a.y};
    const p2: Point = {x: mid, y: b.y};
    return Array.from({length: 33}, (_, i) => {
        const t = i / 32;
        const u = 1 - t;
        const at = (k: 'x' | 'y'): number =>
            u * u * u * a[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * b[k];
        return {x: at('x'), y: at('y')};
    });
}

const ACTIVE_CABLE = curve(ORIGIN, TOP_END);
const QUIET_CABLE = curve(ORIGIN, BOT_END);

type Rgba = readonly [number, number, number, number];

/** In colour on Windows: Dawn Ember for the lit branch, neutral slate for the quiet branch, and green/amber for status. */
const EMBER: Rgba = [0xf0, 0x7b, 0x32, 1];
const QUIET_RGB: readonly [number, number, number] = [0x9c, 0x97, 0xb0];
const DOT_COLOURS: Record<Exclude<TrayState, 'idle'>, Rgba> = {
    watching: [0x22, 0xc5, 0x5e, 1],
    busy: [0xf5, 0x9e, 0x0b, 1],
};
/** A Mac's menu bar takes a template: black with alpha, and macOS tints it to suit the bar. */
const TEMPLATE_SOLID: Rgba = [0, 0, 0, 1];

/** Shortest distance squared from `p` to a sampled curve, plus approximate progress `t` in [0, 1]. */
function curveHit(p: Point, pts: Point[], halfWidth: number): number | null {
    const reach = halfWidth * halfWidth;
    let bestD2 = Infinity;
    let bestT = 0;
    const n = pts.length - 1;
    for (let i = 1; i <= n; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const segT = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
        const d2 = (p.x - a.x - segT * dx) ** 2 + (p.y - a.y - segT * dy) ** 2;
        if (d2 <= reach && d2 < bestD2) {
            bestD2 = d2;
            bestT = (i - 1 + segT) / n;
        }
    }
    return bestD2 <= reach ? bestT : null;
}

const dist2 = (p: Point, c: Point): number => (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
const within = (p: Point, c: Point, radius: number): boolean => dist2(p, c) <= radius * radius;

/** The colour (with alpha in [0, 1]) at a point of the square, or null where the icon is clear. */
function paint(p: Point, state: TrayState, template: boolean): Rgba | null {
    // 1. Active Dawn Ember path & endpoints sit cleanly on top.
    if (within(p, ORIGIN, DOT_RADIUS) || within(p, TOP_END, DOT_RADIUS) || curveHit(p, ACTIVE_CABLE, ACTIVE_WIDTH / 2) !== null) {
        return template ? TEMPLATE_SOLID : EMBER;
    }

    // 2. Bottom-right node: solid status dot while watching/busy, soft open ring while idle.
    if (state !== 'idle') {
        if (within(p, BOT_END, STATUS_DOT_RADIUS)) {
            return template ? TEMPLATE_SOLID : DOT_COLOURS[state];
        }
    } else {
        const d2 = dist2(p, BOT_END);
        if (d2 <= QUIET_RING_OUTER * QUIET_RING_OUTER) {
            if (d2 < QUIET_RING_INNER * QUIET_RING_INNER) return null;
            return template ? [0, 0, 0, 0.45] : [QUIET_RGB[0], QUIET_RGB[1], QUIET_RGB[2], 0.6];
        }
    }

    // 3. Quiet lower branch fading smoothly away from the origin toward the bottom-right node.
    const quietT = curveHit(p, QUIET_CABLE, QUIET_WIDTH / 2);
    if (quietT !== null) {
        const alpha = template ? 0.52 - 0.28 * quietT : 0.78 - 0.4 * quietT;
        return template ? [0, 0, 0, alpha] : [QUIET_RGB[0], QUIET_RGB[1], QUIET_RGB[2], alpha];
    }

    return null;
}

/** Each pixel is this many samples a side, so edges are smoothed rather than stepped. */
const SAMPLES = 4;

/** The icon `size` pixels square, as straight RGBA rows. */
function pixels(size: number, state: TrayState, template: boolean): Buffer {
    const out = Buffer.alloc(size * size * 4);
    const scale = ICON_POINTS / size;
    const totalSamples = SAMPLES * SAMPLES;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let sy = 0; sy < SAMPLES; sy++) {
                for (let sx = 0; sx < SAMPLES; sx++) {
                    const colour = paint(
                        {x: (x + (sx + 0.5) / SAMPLES) * scale, y: (y + (sy + 0.5) / SAMPLES) * scale},
                        state,
                        template,
                    );
                    if (!colour) continue;
                    const sa = colour[3];
                    r += colour[0] * sa;
                    g += colour[1] * sa;
                    b += colour[2] * sa;
                    a += sa;
                }
            }
            if (a === 0) continue;
            const at = (y * size + x) * 4;
            out[at] = Math.round(r / a);
            out[at + 1] = Math.round(g / a);
            out[at + 2] = Math.round(b / a);
            out[at + 3] = Math.round((255 * a) / totalSamples);
        }
    }
    return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(typed.length + 8);
    out.writeUInt32BE(data.length, 0);
    typed.copy(out, 4);
    out.writeUInt32BE(crc32(typed), typed.length + 4);
    return out;
}

/** RGBA rows as a PNG: 8 bits a channel, each row unfiltered. */
function png(size: number, rgba: Buffer): Buffer {
    const stride = size * 4;
    const rows = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y++) rgba.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([
        PNG_SIGNATURE,
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** The icon as a PNG `size` pixels square: in colour, or as a Mac's menu bar template. */
export function drawTrayIcon(size: number, state: TrayState, template: boolean): Buffer {
    return png(size, pixels(size, state, template));
}
