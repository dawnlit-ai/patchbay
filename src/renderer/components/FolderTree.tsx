import type { JSX } from 'react';
import { useState } from 'react';
import { readsFolder, type TriggerConfig } from '@shared/flow';
import type { InboxFolderOption } from '@shared/ipc';
import { PickFilter, PickGroup } from './PickGroup';

/** What the tree edits on a trigger. */
type Choice = Pick<TriggerConfig, 'folders'>;

interface Row {
    /** Under the Inbox, as a trigger stores it: '' is the Inbox itself. */
    path: string;
    name: string;
    depth: number;
    itemCount?: number;
    /** Ticked, but not among the folders Outlook listed: renamed, deleted, or too deep to list. */
    missing?: boolean;
}

const lower = (path: string): string => path.toLowerCase();

/** Whether `path` is `top` or sits somewhere inside it. Everything sits inside the Inbox. */
const within = (path: string, top: string): boolean =>
    top === '' || lower(path) === lower(top) || lower(path).startsWith(`${lower(top)}\\`);

/**
 * The Inbox's folders as a list of ticks, one folder each. A tick reads that
 * folder alone; "+ below" ticks a folder and everything inside it at once, and
 * unticking a folder unticks everything inside it. A folder made later is not
 * read until it is ticked.
 */
export function FolderTree({
                               choice,
                               listed,
                               note,
                               onChange,
                           }: {
    choice: Choice;
    /** The Inbox and every folder below it, depth-first. Null until Outlook has listed them. */
    listed: InboxFolderOption[] | null;
    /** Why there is no list to tick yet. */
    note?: string;
    onChange(choice: Partial<Choice>): void;
}): JSX.Element {
    const [query, setQuery] = useState('');

    const known = listed ?? [];
    const paths = known.map((f) => f.relativePath);
    const listedPaths = new Set(paths.map(lower));
    // A ticked folder Outlook no longer lists stays in sight, so it can be unticked.
    const missing = listed ? choice.folders.filter((f) => !listedPaths.has(lower(f))) : [];
    const rows: Row[] = [
        ...known.map((f) => ({
            path: f.relativePath,
            name: f.relativePath === '' ? 'Inbox' : f.name,
            depth: f.depth,
            itemCount: f.depth > 0 ? f.itemCount : undefined,
        })),
        ...missing.map((path) => ({path, name: path || 'Inbox', depth: 0, missing: true})),
    ];

    const ticked = (path: string): boolean => readsFolder(choice, path);
    const write = (tick: (path: string) => boolean): void => onChange({folders: [...paths, ...missing].filter(tick)});

    /** Ticking takes the folder alone; unticking takes the folders inside it too — for the Inbox, every one. */
    const toggle = (path: string): void => {
        if (!ticked(path)) write((p) => p === path || ticked(p));
        else write((p) => !within(p, path) && ticked(p));
    };
    const below = (path: string): string[] => paths.filter((p) => within(p, path));
    const tickBelow = (path: string): void => write((p) => within(p, path) || ticked(p));

    const searching = query.trim() !== '';
    return (
        <>
            <PickFilter value={query} total={rows.length} noun="folders" onChange={setQuery}/>
            <PickGroup
                title="Folders"
                tip="The folders this trigger reads. Ticking one takes that folder alone; unticking one unticks the folders inside it too."
                items={listed ? rows : []}
                isTicked={(row) => ticked(row.path)}
                query={query}
                text={(row) => row.path || 'Inbox'}
                note={listed ? undefined : note}
                actions={
                    listed && (
                        <>
                            <button className="compact" onClick={() => write(() => true)}>
                                All
                            </button>
                            <button className="compact" onClick={() => write(() => false)}>
                                None
                            </button>
                        </>
                    )
                }
                row={(row) => {
                    // Offered while anything inside is unticked; unticking the folder unticks the lot.
                    const tickable = below(row.path).length > 1 && !below(row.path).every(ticked);
                    return (
                        <div
                            key={row.missing ? `missing:${row.path}` : row.path || '(inbox)'}
                            className="pick-row folder-row"
                            style={{paddingLeft: searching ? 0 : row.depth * 14}}
                        >
                            <label className="check" title={row.path ? `Inbox\\${row.path}` : 'Inbox'}>
                                <input type="checkbox" checked={ticked(row.path)}
                                       onChange={() => toggle(row.path)}/>
                                <span className="folder-name">{searching ? row.path || 'Inbox' : row.name}</span>
                                {row.itemCount !== undefined &&
                                    <span className="folder-note">{row.itemCount}</span>}
                                {row.missing && <span className="folder-note">not in this mailbox</span>}
                            </label>
                            {tickable && (
                                <button
                                    className="compact"
                                    title="Tick it and every folder below it"
                                    onClick={() => tickBelow(row.path)}
                                >
                                    + below
                                </button>
                            )}
                        </div>
                    );
                }}
            />
            <div className="hint block">
                {listed && choice.folders.length === 0
                    ? 'Nothing ticked — this trigger reads no mail.'
                    : 'A folder made later, by you or a rule, is read only once you tick it here.'}
            </div>
        </>
    );
}
