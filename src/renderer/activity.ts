import type { LiveText, PassUnderWay } from '@shared/trace';

/** The tool Claude Code hands in a step's structured result through. */
const RESULT_TOOL = 'StructuredOutput';

/** What a block being written is, in a few words. */
export function liveLabel(live: LiveText): string {
    switch (live.type) {
        case 'assistant':
            return 'Writing…';
        case 'thinking':
            return 'Thinking…';
        case 'tool-call':
            return live.label === RESULT_TOOL ? 'Writing its result…' : `Writing the input for ${live.label}…`;
    }
}

/** What a node at work is doing now, from the newest thing it did. */
export function activity(pass: PassUnderWay): string {
    if (pass.live) return liveLabel(pass.live);
    const last = pass.events.at(-1);
    switch (last?.type) {
        case undefined:
            return 'Starting…';
        case 'tool-call':
            return last.label === RESULT_TOOL ? 'Finishing…' : `Running ${last.label}…`;
        // A wait for the usage limit, a retry, a body read: each says what it is.
        case 'note':
        case 'outlook':
        case 'error':
            return last.label;
        default:
            return 'Waiting for the model…';
    }
}
