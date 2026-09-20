import { useCallback, useState } from 'react';

/**
 * The banner across the top of a window, and the one way anything reaches it:
 * run the action, and whatever it throws is what the person reads. Both windows
 * report failure the same way, so they share the plumbing rather than each
 * keeping their own copy of the same try/catch.
 */
export interface ErrorBanner {
    /** What to show, or null for nothing. */
    error: string | null;

    /** Run an action, putting anything it throws in the banner. */
    attempt(what: () => Promise<unknown>): Promise<void>;

    /** Say something the window worked out for itself, or clear it with null. */
    report(message: string | null): void;
}

export function useErrorBanner(): ErrorBanner {
    const [error, report] = useState<string | null>(null);

    const attempt = useCallback(async (what: () => Promise<unknown>): Promise<void> => {
        report(null);
        try {
            await what();
        } catch (e) {
            report((e as Error).message);
        }
    }, []);

    return { error, attempt, report };
}
