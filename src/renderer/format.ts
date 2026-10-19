/** Date and time formatting shared by every list, in the machine's locale. */

/** Just the time of day: these lists are read the day they are written. */
export const time = (iso: string): string => new Date(iso).toLocaleTimeString();

/** When something still ahead happens: the time if today, the weekday and time within the week, else the date. */
export function ahead(iso: string): string {
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) return 'at an unknown time';
    const clock = at.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
    if (at.toDateString() === new Date().toDateString()) return clock;
    if (at.getTime() - Date.now() < 6 * 86_400_000) return `${at.toLocaleDateString([], {weekday: 'short'})} ${clock}`;
    return at.toLocaleDateString([], {month: 'short', day: 'numeric'});
}

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

/** A span of time as a clock reads it: 42s, 3:07, 1:02:09. */
export function duration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const pad = (n: number): string => String(n).padStart(2, '0');
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const clock = `${pad(minutes)}:${pad(seconds % 60)}`;
    return hours > 0 ? `${hours}:${clock}` : clock.replace(/^0/, '');
}
