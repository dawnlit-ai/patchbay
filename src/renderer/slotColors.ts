import { EMAIL_SLOT, type FlowNode, outputPorts, provides } from '@shared/flow';

/** Slot name → its colour token: `email`, or a number from 1 to DATA_HUES. */
export type DataTokens = ReadonlyMap<string, string>;

/** How many colours the slots nodes fill take turns at: `--data-1` to `--data-6`. */
const DATA_HUES = 6;

/**
 * A colour for each slot the flow fills: the email's own, then the next in turn
 * for each other slot, in the order the nodes filling them sit in the flow. Two
 * slots of one flow share a colour only once it fills more than DATA_HUES.
 */
export function dataTokens(nodes: FlowNode[]): DataTokens {
    const tokens = new Map([[EMAIL_SLOT.name, 'email']]);
    for (const node of nodes) {
        for (const port of outputPorts(node)) {
            for (const slot of provides(node, port.id)) {
                if (!tokens.has(slot.name)) tokens.set(slot.name, String(((tokens.size - 1) % DATA_HUES) + 1));
            }
        }
    }
    return tokens;
}

/** The classes that colour a wire, a handle or a chip by its slot's token: `.data-<token>` sets `--d`. Empty when unknown. */
export const tint = (token: string | undefined): string => (token === undefined ? '' : `tinted data-${token}`);
