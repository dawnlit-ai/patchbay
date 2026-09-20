/**
 * How the window writes a date. The runs list, the console and Settings all
 * print a clock time, and the flow list prints how long ago — one place, so
 * they agree with each other and with the machine's own locale.
 */

/** Just the time of day: these lists are read the day they are written. */
export const time = (iso: string): string => new Date(iso).toLocaleTimeString();

/** How long ago, falling back to a date once "days ago" stops meaning much. */
export function ago(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return 'never';
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    return new Date(iso).toLocaleDateString();
}
