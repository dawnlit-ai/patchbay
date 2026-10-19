import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { duration } from '../format';

/** How long since `from`, counting up while it is on screen. */
export function Elapsed({from}: { from: string }): JSX.Element {
    const [at, setAt] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setAt(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, []);
    return <>{duration(at - new Date(from).getTime())}</>;
}
