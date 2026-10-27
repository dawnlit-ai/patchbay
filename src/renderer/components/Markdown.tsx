import type { JSX, ReactNode } from 'react';
import { useState } from 'react';

/**
 * Markdown as a README uses it: headings, paragraphs, lists, quotes, code,
 * tables, emphasis and links. Built as React elements and never as HTML, so
 * nothing in the file can run: raw HTML shows as the text it is, an image as its
 * alt text, and a link copies where it points rather than leaving the app.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const COMMENT = /^ {0,3}<!--/;
const SETEXT_1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_2 = /^ {0,3}-+[ \t]*$/;

const isTableAt = (lines: string[], i: number): boolean =>
    (lines[i] ?? '').includes('|') && TABLE_RULE.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-');

/** A line that ends a paragraph by starting a block of its own. */
const startsBlock = (lines: string[], i: number): boolean => {
    const line = lines[i] ?? '';
    return (
        FENCE.test(line) ||
        HEADING.test(line) ||
        RULE.test(line) ||
        QUOTE.test(line) ||
        ITEM.test(line) ||
        COMMENT.test(line) ||
        isTableAt(lines, i)
    );
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

const cellsOf = (row: string): string[] =>
    row
        .trim()
        .replace(/^\|/, '')
        .replace(/(?<!\\)\|$/, '')
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, '|'));

type Align = 'left' | 'center' | 'right' | undefined;

const alignOf = (cell: string): Align =>
    cell.startsWith(':') && cell.endsWith(':')
        ? 'center'
        : cell.endsWith(':')
            ? 'right'
            : cell.startsWith(':')
                ? 'left'
                : undefined;

/** The blocks in some lines, each keyed by where it starts. */
function blocks(lines: string[]): ReactNode[] {
    const out: ReactNode[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? '';
        const key = String(i);

        if (!line.trim()) {
            i++;
            continue;
        }

        const fence = FENCE.exec(line);
        if (fence) {
            // Closed by a fence of the same character at least as long, or by the end.
            const mark = fence[1] ?? '```';
            const closing = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
            const body: string[] = [];
            for (i++; i < lines.length && !closing.test(lines[i] ?? ''); i++) body.push(lines[i] ?? '');
            i++;
            out.push(
                <pre key={key}>
                    <code>{body.join('\n')}</code>
                </pre>,
            );
            continue;
        }

        // A comment is for whoever edits the file, not whoever reads it.
        if (COMMENT.test(line)) {
            while (i < lines.length && !(lines[i] ?? '').includes('-->')) i++;
            i++;
            continue;
        }

        const heading = HEADING.exec(line);
        if (heading) {
            out.push(header(heading[1]?.length ?? 1, heading[2] ?? '', key));
            i++;
            continue;
        }

        if (RULE.test(line)) {
            out.push(<hr key={key}/>);
            i++;
            continue;
        }

        if (QUOTE.test(line)) {
            const inner: string[] = [];
            for (; i < lines.length && QUOTE.test(lines[i] ?? ''); i++) inner.push(QUOTE.exec(lines[i] ?? '')?.[1] ?? '');
            out.push(<blockquote key={key}>{blocks(inner)}</blockquote>);
            continue;
        }

        if (ITEM.test(line)) {
            const [list, next] = listAt(lines, i, key);
            out.push(list);
            i = next;
            continue;
        }

        if (isTableAt(lines, i)) {
            const head = cellsOf(line);
            const aligns = cellsOf(lines[i + 1] ?? '').map(alignOf);
            const rows: string[][] = [];
            for (i += 2; i < lines.length && (lines[i] ?? '').trim() && (lines[i] ?? '').includes('|'); i++) {
                rows.push(cellsOf(lines[i] ?? ''));
            }
            out.push(
                <div key={key} className="md-table">
                    <table>
                        <thead>
                        <tr>
                            {head.map((cell, c) => (
                                <th key={c} style={{textAlign: aligns[c]}}>
                                    {inline(cell)}
                                </th>
                            ))}
                        </tr>
                        </thead>
                        <tbody>
                        {rows.map((row, r) => (
                            <tr key={r}>
                                {head.map((_, c) => (
                                    <td key={c} style={{textAlign: aligns[c]}}>
                                        {inline(row[c] ?? '')}
                                    </td>
                                ))}
                            </tr>
                        ))}
                        </tbody>
                    </table>
                </div>,
            );
            continue;
        }

        // A paragraph: every line up to a blank one or the start of another block,
        // unless an underline makes it a heading.
        const para: string[] = [line];
        let level = 0;
        for (i++; i < lines.length && (lines[i] ?? '').trim(); i++) {
            const next = lines[i] ?? '';
            if (SETEXT_1.test(next) || SETEXT_2.test(next)) {
                level = SETEXT_1.test(next) ? 1 : 2;
                i++;
                break;
            }
            if (startsBlock(lines, i)) break;
            para.push(next);
        }
        const text = para.map((l) => l.replace(/^[ \t]+/, '')).join('\n');
        out.push(level > 0 ? header(level, text, key) : <p key={key}>{inline(text)}</p>);
    }
    return out;
}

function header(level: number, text: string, key: string): ReactNode {
    const Tag = `h${Math.min(6, Math.max(1, level))}` as 'h1';
    return <Tag key={key}>{inline(text)}</Tag>;
}

/**
 * The list starting at `start`, and the line after it. An item runs on through
 * lines indented past its marker, so a list inside one is that item's own.
 */
function listAt(lines: string[], start: number, key: string): [ReactNode, number] {
    const first = ITEM.exec(lines[start] ?? '');
    const base = first?.[1]?.length ?? 0;
    const ordered = /\d/.test(first?.[2] ?? '');
    const sibling = (m: RegExpExecArray | null): m is RegExpExecArray =>
        m !== null && (m[1]?.length ?? 0) === base && /\d/.test(m[2] ?? '') === ordered;

    const items: string[][] = [];
    let width = 0;
    let loose = false;
    let i = start;
    while (i < lines.length) {
        const line = lines[i] ?? '';
        const m = ITEM.exec(line);
        if (sibling(m)) {
            // Its content starts after the marker and one space; lines under it are dedented to there.
            width = base + (m[2]?.length ?? 1) + 1;
            items.push([m[3] ?? '']);
            i++;
            continue;
        }
        const current = items.at(-1);
        if (!current) break;
        if (!line.trim()) {
            let j = i + 1;
            while (j < lines.length && !(lines[j] ?? '').trim()) j++;
            const after = lines[j];
            if (after === undefined || !(sibling(ITEM.exec(after)) || indentOf(after) > base)) break;
            // A blank line inside the list spaces its items out as paragraphs.
            loose = true;
            current.push('');
            i++;
            continue;
        }
        if (indentOf(line) > base) {
            current.push(line.slice(Math.min(indentOf(line), width)));
            i++;
            continue;
        }
        // A plain line under an item's text carries that text on, unindented or not.
        if (!startsBlock(lines, i) && (current.at(-1) ?? '').trim()) {
            current.push(line.trim());
            i++;
            continue;
        }
        break;
    }

    const rendered = items.map((item, n) => {
        const [lead = '', ...rest] = item;
        const task = /^\[([ xX])\][ \t]+/.exec(lead);
        const body = task ? [lead.slice(task[0].length), ...rest] : item;
        return (
            <li key={n} className={task ? 'task' : undefined}>
                {task && <span className="md-check">{task[1] === ' ' ? '☐' : '☑'}</span>}
                {blocks(body)}
            </li>
        );
    });
    const className = loose ? undefined : 'tight';
    const start1 = ordered ? Number.parseInt(first?.[2] ?? '1', 10) : 1;
    return [
        ordered ? (
            <ol key={key} className={className} start={start1 === 1 ? undefined : start1}>
                {rendered}
            </ol>
        ) : (
            <ul key={key} className={className}>
                {rendered}
            </ul>
        ),
        i,
    ];
}

// ── Inline ───────────────────────────────────────────────────────────────

type Render = (m: RegExpExecArray, key: string) => ReactNode;

/** Each span, earliest match first; at the same place, the one listed first wins. */
const SPANS: [RegExp, Render][] = [
    [/\\([\\`*_{}[\]()#+\-.!~|<>])/, (m) => m[1]],
    [
        /(`+)([\s\S]*?[^`])\1(?!`)/,
        (m, key) => <code key={key}>{(m[2] ?? '').replace(/^ ([\s\S]*) $/, '$1')}</code>,
    ],
    [
        /!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/,
        (m, key) => (
            <em key={key} className="md-image" title={m[2]}>
                {m[1] || 'image'}
            </em>
        ),
    ],
    [
        /\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/,
        (m, key) => (
            <Link key={key} href={m[2] ?? ''}>
                {inline(m[1] ?? '')}
            </Link>
        ),
    ],
    [
        /<((?:https?:\/\/|mailto:)[^>\s]+)>/,
        (m, key) => (
            <Link key={key} href={m[1] ?? ''}>
                {m[1]}
            </Link>
        ),
    ],
    // A closing mark is never one escaped with a backslash, which is a character of the text.
    [
        /\*\*\*(?=\S)([\s\S]*?[^\s\\])\*\*\*/,
        (m, key) => (
            <strong key={key}>
                <em>{inline(m[1] ?? '')}</em>
            </strong>
        ),
    ],
    [
        /\*\*(?=\S)([\s\S]*?[^\s\\])\*\*|(?<!\w)__(?=\S)([\s\S]*?[^\s\\])__(?!\w)/,
        (m, key) => <strong key={key}>{inline(m[1] ?? m[2] ?? '')}</strong>,
    ],
    [/~~(?=\S)([\s\S]*?[^\s\\])~~/, (m, key) => <s key={key}>{inline(m[1] ?? '')}</s>],
    [
        /\*(?=\S)([\s\S]*?[^\s\\])\*|(?<!\w)_(?=\S)([\s\S]*?[^\s\\])_(?!\w)/,
        (m, key) => <em key={key}>{inline(m[1] ?? m[2] ?? '')}</em>,
    ],
    [/ {2,}\n|\\\n/, (_, key) => <br key={key}/>],
];

function inline(text: string): ReactNode[] {
    const out: ReactNode[] = [];
    let rest = text;
    for (let n = 0; rest; n++) {
        let best: { m: RegExpExecArray; render: Render } | null = null;
        for (const [pattern, render] of SPANS) {
            const m = pattern.exec(rest);
            if (m && (best === null || m.index < best.m.index)) best = {m, render};
        }
        if (!best) {
            out.push(rest);
            break;
        }
        if (best.m.index > 0) out.push(rest.slice(0, best.m.index));
        out.push(best.render(best.m, String(n)));
        rest = rest.slice(best.m.index + best.m[0].length);
    }
    return out;
}

/**
 * A link, which copies where it points. Nothing a file says is handed to the
 * system to open, so a README cannot launch a program or a page by being read.
 */
function Link({href, children}: { href: string; children: ReactNode }): JSX.Element {
    const [copied, setCopied] = useState(false);
    if (!href || href.startsWith('#')) return <span className="md-link-text">{children}</span>;
    return (
        <button
            type="button"
            className="md-link"
            title={`${href}\nClick to copy`}
            onClick={() => {
                void window.api.copyText(href).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                });
            }}
        >
            {children}
            {copied && <span className="md-copied">copied</span>}
        </button>
    );
}

export function Markdown({source}: { source: string }): JSX.Element {
    // Tabs count as four spaces wherever indentation decides what a line belongs to.
    const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    return <div className="md">{blocks(lines)}</div>;
}
