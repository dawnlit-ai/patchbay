/**
 * Claude's usage limit belongs to the login, not to one run. Once a call hits
 * it, every call waits for the reset, rather than each queued run failing in
 * turn and its email, already marked seen, never being run.
 */

/** When the limit names no reset: long enough not to hammer it, short enough to notice it lifting. */
const FALLBACK_MS = 15 * 60_000;

/** A reset named a few minutes ago has not taken yet, rather than being a day away. */
const GRACE_MS = 15 * 60_000;

/** A single timer stays well under setTimeout's ceiling, and a clock change is caught on waking. */
const MAX_SLEEP_MS = 60 * 60_000;

const LIMIT = /\b(?:session|usage|weekly) limit\b|\blimit reached\b/i;

/** "resets 3:20am (America/Los_Angeles)", or with a date: "resets Oct 3, 3:20am (…)". */
const RESET = /resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

let heldUntil = 0;

export interface UsageLimit {
    /** Epoch ms when calls may try again. */
    until: number;
}

/** The usage limit an error reports, or null when it is some other failure. */
export function usageLimit(error: string, now = Date.now()): UsageLimit | null {
    if (!LIMIT.test(error)) return null;
    return { until: resetTime(error, now) ?? now + FALLBACK_MS };
}

/** Holds every call until `limit.until`. True when that moves the hold later, which is worth saying once. */
export function holdUsage(limit: UsageLimit): boolean {
    if (limit.until <= heldUntil) return false;
    heldUntil = limit.until;
    return true;
}

/** When the hold lifts, or 0 when calls are free to go. */
export function usageHeldUntil(): number {
    return heldUntil > Date.now() ? heldUntil : 0;
}

/** Resolves once the hold has lifted; rejects if `signal` aborts first. */
export async function waitForUsage(signal?: AbortSignal): Promise<void> {
    while (Date.now() < heldUntil) {
        await sleep(Math.min(heldUntil - Date.now(), MAX_SLEEP_MS), signal);
    }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
        }
        const abort = (): void => {
            clearTimeout(timer);
            reject(new Error('aborted'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', abort, { once: true });
    });
}

/** The instant the error's reset names — the next one, when it gives only a time. Null when it names none. */
function resetTime(error: string, now: number): number | null {
    const m = RESET.exec(error);
    if (!m) return null;
    const [, mon, day, h, min, ampm, zone] = m;
    const hour = (Number(h) % 12) + (ampm?.toLowerCase() === 'p' ? 12 : 0);
    const minute = Number(min ?? 0);
    try {
        const offset = zoneOffset(zone?.trim(), now);
        // The zone's wall clock, read through the UTC getters.
        const wall = new Date(now + offset);
        const month = mon ? MONTHS.indexOf(mon.toLowerCase()) : wall.getUTCMonth();
        if (month < 0) return null;
        const date = mon ? Number(day) : wall.getUTCDate();
        let target = Date.UTC(wall.getUTCFullYear(), month, date, hour, minute);
        if (target <= wall.getTime()) {
            if (wall.getTime() - target < GRACE_MS) return now + 60_000;
            target = mon
                ? Date.UTC(wall.getUTCFullYear() + 1, month, date, hour, minute)
                : target + 86_400_000;
        }
        return target - offset;
    } catch {
        // A zone Intl doesn't know.
        return null;
    }
}

/** How far `zone`'s wall clock runs ahead of UTC at `at`, in ms. Undefined is the machine's own zone. */
function zoneOffset(zone: string | undefined, at: number): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
    }).formatToParts(new Date(at));
    const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return wall - (at - (at % 1000));
}
