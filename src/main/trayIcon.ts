import { crc32, deflateSync } from 'node:zlib';

/**
 * The tray icon, drawn here rather than shipped as a file: two jacks and the
 * cable between them, leaving each level as a wire leaves a port on the canvas,
 * and a dot for what Patchbay is doing. Drawn afresh at each size a screen's
 * scaling asks for, so none is a blurred copy of another. Takes nothing from
 * Electron, so a script can draw it to look at.
 */

/** What the dot says: nothing watched, flows watched, or runs under way, waiting or under review. */
export type TrayState = 'idle' | 'watching' | 'busy';

interface Point {
    x: number;
    y: number;
}

/** The icon is laid out on a square this many points across, and drawn at that times the screen's scaling. */
export const ICON_POINTS = 16;

const JACKS: Point[] = [{x: 4, y: 11}, {x: 12, y: 4}];
const JACK_RADIUS = 2.6;
const CABLE_WIDTH = 1.7;
/** The corner the cable leaves clear, where the dot goes. */
const DOT = {x: 12.5, y: 12.5, radius: 3};

/** How far along the way to the other jack the cable runs level before it turns: more is a deeper S. */
const BEND = 0.9;

/** The cable as short straight pieces: a curve out of one jack and into the other, each level at its end. */
const CABLE: Point[] = (() => {
    const [a, b] = JACKS as [Point, Point];
    const reach = BEND * (b.x - a.x);
    const [p0, p1, p2, p3] = [a, {x: a.x + reach, y: a.y}, {x: b.x - reach, y: b.y}, b];
    return Array.from({length: 33}, (_, i) => {
        const t = i / 32;
        const u = 1 - t;
        const at = (k: 'x' | 'y'): number => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k];
        return {x: at('x'), y: at('y')};
    });
})();

type Rgb = readonly [number, number, number];

/** In colour on Windows: a blue that reads on a light taskbar and a dark one, and the app's own green and amber. */
const GLYPH: Rgb = [0x3b, 0x82, 0xf6];
const DOT_COLOURS: Record<Exclude<TrayState, 'idle'>, Rgb> = {
    watching: [0x22, 0xc5, 0x5e],
    busy: [0xf5, 0x9e, 0x0b],
};
/** A Mac's menu bar takes a template: black, and macOS colours it to suit the bar. */
const TEMPLATE: Rgb = [0, 0, 0];

function nearCable(p: Point): boolean {
    const reach = (CABLE_WIDTH / 2) ** 2;
    for (let i = 1; i < CABLE.length; i++) {
        const a = CABLE[i - 1]!;
        const b = CABLE[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
        if ((p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2 <= reach) return true;
    }
    return false;
}

const within = (p: Point, c: Point, radius: number): boolean => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 <= radius * radius;

/** The colour at a point of the square, or null where the icon is clear. */
function paint(p: Point, state: TrayState, template: boolean): Rgb | null {
    if (state !== 'idle' && within(p, DOT, DOT.radius)) return template ? TEMPLATE : DOT_COLOURS[state];
    if (JACKS.some((jack) => within(p, jack, JACK_RADIUS)) || nearCable(p)) return template ? TEMPLATE : GLYPH;
    return null;
}

/** Each pixel is this many samples a side, so edges are smoothed rather than stepped. */
const SAMPLES = 4;

/** The icon `size` pixels square, as straight RGBA rows. */
function pixels(size: number, state: TrayState, template: boolean): Buffer {
    const out = Buffer.alloc(size * size * 4);
    const scale = ICON_POINTS / size;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let hits = 0;
            for (let sy = 0; sy < SAMPLES; sy++) {
                for (let sx = 0; sx < SAMPLES; sx++) {
                    const colour = paint(
                        {x: (x + (sx + 0.5) / SAMPLES) * scale, y: (y + (sy + 0.5) / SAMPLES) * scale},
                        state,
                        template,
                    );
                    if (!colour) continue;
                    r += colour[0];
                    g += colour[1];
                    b += colour[2];
                    hits++;
                }
            }
            if (hits === 0) continue;
            const at = (y * size + x) * 4;
            out[at] = Math.round(r / hits);
            out[at + 1] = Math.round(g / hits);
            out[at + 2] = Math.round(b / hits);
            out[at + 3] = Math.round((255 * hits) / (SAMPLES * SAMPLES));
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
