/**
 * Smoke test for the agent-control MCP server — the one an agent connects to in
 * order to drive the app.
 *
 * Runs under Electron, so the real server, stores and settings are exercised
 * rather than stubbed, but against a throwaway workspace in the temp directory:
 * the flow it builds and the skill it writes are not yours. It calls neither
 * Outlook nor Claude, so it is free and safe to run at any time.
 *
 *   npm run mcpcheck
 */
import { app } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Not the default port: a check should not fight the app if it is running. */
const PORT = 8799;
const TOKEN = 'mcpcheck-token';

const workspace = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-'));
app.setPath('userData', workspace);

let failures = 0;

function check(what: string, ok: boolean, detail = ''): void {
    if (!ok) failures += 1;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
    // Imported here rather than at the top, so the workspace above is already
    // redirected by the time anything resolves a path inside it.
    const { getSettings, saveSettings } = await import('../src/main/store/settingsStore');
    const { AgentControl } = await import('../src/main/mcp/server');
    const { Watcher } = await import('../src/main/engine/watcher');
    const { getFlow, saveFlowFrom } = await import('../src/main/store/flowStore');
    const { listAllSkills } = await import('../src/main/store/skillStore');

    console.log('workspace:', workspace);
    saveSettings({ ...getSettings(), agentControl: { enabled: true, port: PORT, token: TOKEN } });

    const watcher = new Watcher(
        () => {
        },
        () => {
        },
    );
    const control = new AgentControl(
        {
            watcher: () => watcher,
            changed: () => {
            },
        },
        () => {
        },
    );

    control.apply();
    for (let i = 0; i < 50 && !control.status().running; i++) await new Promise((r) => setTimeout(r, 100));
    const status = control.status();
    check('listening', status.running, status.lastError ?? status.url);
    if (!status.running) throw new Error('nothing to test against');

    const refused = await fetch(status.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
        body: '{}',
    });
    check('a wrong token is refused', refused.status === 401, `HTTP ${refused.status}`);

    const client = new Client({ name: 'mcpcheck', version: '1.0.0' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(status.url), {
            requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        }),
    );

    const { tools } = await client.listTools();
    check(`${tools.length} tools listed`, tools.length > 0);

    /** Calls a tool and returns its text, failing the check if it errored. */
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as { type: string; text?: string }[])
            .map((part) => part.text ?? `[${part.type}]`)
            .join('\n');
        check(name, result.isError !== true, result.isError ? text.slice(0, 200) : '');
        return text;
    };

    const flowId = (JSON.parse(await call('create_flow', { name: 'Wired by an agent' })) as { id: string }).id;
    const idOf = async (kind: string, name?: string): Promise<string> =>
        (JSON.parse(await call('add_node', { flowId, kind, ...(name ? { name } : {}) })) as { id: string }).id;

    const trigger = await idOf('trigger.outlook', 'Pre-alerts');
    const sorter = await idOf('categorizer');
    const done = await idOf('terminal');

    // A patch of two real fields and one of the wrong type: the good ones stick,
    // and the bad one falls back to its default rather than reaching a run.
    const patched = await call('update_node', {
        flowId,
        nodeId: sorter,
        name: 'Sort',
        config: {
            categories: [
                { id: 'pre-alert', label: 'Pre-alert', description: 'A shipment pre-alert with an HBL.' },
                { id: 'rate', label: 'Rate quote', description: 'A trucking company quoting a lane.' },
            ],
            bodyMaxChars: 'not a number',
        },
    });
    check('a bad value falls back to its default', patched.includes('"bodyMaxChars": 8000'));

    await call('connect', { flowId, from: trigger, port: 'out', to: sorter });
    await call('connect', { flowId, from: sorter, port: 'cat:pre-alert', to: done });

    const wrongPort = await client.callTool({
        name: 'connect',
        arguments: { flowId, from: trigger, port: 'nonsense', to: done },
    });
    check('a port that does not exist is refused', wrongPort.isError === true);

    // Dropping the category takes the edge that left its port with it.
    const dropped = await call('update_node', {
        flowId,
        nodeId: sorter,
        config: { categories: [{ id: 'rate', label: 'Rate quote', description: 'A rate reply.' }] },
    });
    check('an edge left hanging is dropped and reported', dropped.includes('"droppedEdges": 1'));

    await call('write_skill', {
        scope: 'flow',
        flowId,
        name: 'check-skill',
        content: '---\nname: check-skill\ndescription: A skill written over MCP.\n---\n\nDo the thing.\n',
    });
    check(
        'the skill is in the flow’s library',
        (await call('list_skills', { flowId })).includes('check-skill'),
    );

    // A skill is a folder, not a file: what sits beside SKILL.md has to come too.
    const shelf = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-skills-'));
    for (const name of ['alpha', 'beta']) {
        mkdirSync(join(shelf, name, 'references'), { recursive: true });
        writeFileSync(
            join(shelf, name, 'SKILL.md'),
            `---\nname: ${name}\ndescription: Imported over MCP.\n---\n\nRead references/notes.md.\n`,
        );
        writeFileSync(join(shelf, name, 'references', 'notes.md'), 'A file beside the SKILL.md.\n');
    }
    const imported = JSON.parse(
        await call('import_skills', { scope: 'flow', flowId, dir: shelf, names: ['alpha', 'nope'] }),
    ) as { imported: string[]; notFound?: string[] };
    check(
        'only the named skill is imported, and a missing one is named',
        imported.imported.join() === 'alpha' && imported.notFound?.join() === 'nope',
    );
    const flowPath =
        (JSON.parse(await call('list_flows')) as { id: string; path: string }[]).find((f) => f.id === flowId)?.path ?? '';
    check(
        'the files beside SKILL.md come with it',
        existsSync(join(flowPath, '.claude', 'skills', 'alpha', 'references', 'notes.md')),
    );
    const itself = await client.callTool({
        name: 'import_skills',
        arguments: { scope: 'flow', flowId, dir: join(shelf, 'alpha') },
    });
    check('a skill folder passed as the shelf is refused', itself.isError === true);
    const relative = await client.callTool({ name: 'import_skills', arguments: { scope: 'global', dir: 'skills' } });
    check('a relative folder is refused', relative.isError === true);

    // Moving a skill changes how it is ticked, so the flow's Processors follow it,
    // and a skill leaving the shelf names every other flow it leaves behind.
    const worker = await idOf('processor');
    await call('update_node', { flowId, nodeId: worker, config: { skills: ['alpha'] } });
    const up = JSON.parse(await call('move_skill', { flowId, name: 'alpha', to: 'global' })) as {
        repointedNodes: string[];
    };
    check(
        'moving a skill re-points this flow’s ticks',
        up.repointedNodes.includes(worker) && (await call('get_flow', { flowId })).includes('"global:alpha"'),
    );
    const other = (JSON.parse(await call('create_flow', { name: 'Also ticks alpha' })) as { id: string }).id;
    const otherWorker = (JSON.parse(await call('add_node', { flowId: other, kind: 'processor' })) as { id: string }).id;
    await call('update_node', { flowId: other, nodeId: otherWorker, config: { skills: ['global:alpha'] } });
    const down = JSON.parse(await call('move_skill', { flowId, name: 'alpha', to: 'flow' })) as {
        stillTickedBy?: { id: string }[];
    };
    check(
        'a skill leaving the shelf names the flows it strands',
        down.stillTickedBy?.some((f) => f.id === other) === true,
    );
    await call('delete_flow', { flowId: other });

    // A run has an id from the moment it is queued. A trigger wired to nothing
    // ends its path at once, so these runs touch neither Outlook nor Claude; two
    // of one flow queued together means the second waits for the first.
    const lane = (JSON.parse(await call('create_flow', { name: 'Queue check' })) as { id: string }).id;
    const start = (JSON.parse(await call('add_node', { flowId: lane, kind: 'trigger.outlook' })) as { id: string }).id;
    const email = {
        ref: { entryId: 'mcpcheck', storeId: 'mcpcheck', account: 'check@example.com', folderPath: '' },
        subject: 'Queue check',
        senderName: 'mcpcheck',
        senderEmail: 'check@example.com',
        receivedTime: new Date().toISOString(),
        bodyPreview: '',
        attachmentNames: [],
    };
    const first = watcher.enqueueManual(lane, start, email);
    const second = watcher.enqueueManual(lane, start, email);
    check(
        'a run behind another of its flow is queued, and says why',
        watcher.queued().find((q) => q.runId === second)?.waitingFor.includes('this flow') === true,
    );
    let refusedMidRun = false;
    try {
        watcher.clearForRemoval(lane);
    } catch {
        refusedMidRun = true;
    }
    check('a flow is not cleared for deleting while a run of it is under way', refusedMidRun);
    check('a queued run can be cancelled', watcher.cancel(second) === 'dequeued' && watcher.queued().length === 0);
    check('cancelling it again finds nothing', watcher.cancel(second) === 'unknown');
    for (let i = 0; i < 50 && watcher.status().activeRunIds.length > 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
    }
    check('the run ahead of it still ran', (await call('get_run', { runId: first })).includes('"status": "completed"'));
    check('list_runs has it', (await call('list_runs', { flowId: lane })).includes(first));
    check(
        'cancel_run says when there is nothing to cancel',
        (await call('cancel_run', { runId: second })).includes('Nothing to cancel'),
    );

    // A canvas saves against the version it last read. Its own saves move that
    // on; anyone else's write means its edit was made to a flow no longer there.
    const loaded = getFlow(lane);
    if (!loaded) throw new Error('the queue check flow is missing');
    const once = saveFlowFrom('canvas', { ...loaded, name: 'Edited once' });
    const twice = saveFlowFrom('canvas', { ...loaded, name: 'Edited twice' });
    check('a canvas saving twice from one read is not refused by its own save', 'saved' in once && 'saved' in twice);
    await call('rename_flow', { flowId: lane, name: 'Renamed by an agent' });
    const overtaken = saveFlowFrom('canvas', { ...loaded, name: 'Edited a third time' });
    check(
        'a canvas edit made before an agent’s write is refused, and handed what is there',
        'current' in overtaken && overtaken.current?.name === 'Renamed by an agent',
    );
    check('the agent’s write stands', getFlow(lane)?.name === 'Renamed by an agent');
    const reread = getFlow(lane);
    check(
        'an edit to the flow as it now stands is saved',
        reread !== null && 'saved' in saveFlowFrom('canvas', { ...reread, name: 'Edited after reading' }),
    );
    const laneFolder = join(workspace, 'workspace', 'flows', lane);
    await call('delete_flow', { flowId: lane });
    const late = reread ? saveFlowFrom('canvas', { ...reread, name: 'Too late' }) : null;
    // What a canvas still showing the flow does next: refresh its skill list.
    listAllSkills(lane);
    check(
        'a save to a deleted flow, or a look at its skills, does not bring it back',
        late !== null && 'current' in late && late.current === null && getFlow(lane) === null && !existsSync(laneFolder),
    );

    // The console: what the app did outside any one run, this session's and a day's.
    check(
        'the console shows an agent’s calls',
        (await call('get_console', { source: 'agent' })).includes('Called create_flow'),
    );
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    check(
        'a day’s file reads back',
        (await call('get_console', { day: today, source: 'run' })).includes('Cancelled before it started'),
    );
    const notADay = await client.callTool({ name: 'get_console', arguments: { day: 'yesterday' } });
    check('a day that is not a date is refused', notADay.isError === true);

    const settings = await call('get_settings');
    check('the token is withheld', settings.includes('(withheld)') && !settings.includes(TOKEN));

    await call('get_status');
    await call('list_runs', { limit: 3 });
    await call('get_flow', { flowId });
    await call('delete_flow', { flowId });

    const missing = await client.callTool({ name: 'get_flow', arguments: { flowId: 'gone' } });
    check('a missing flow comes back as a readable error', missing.isError === true);
    check('and asking after it leaves no folder behind', !existsSync(join(workspace, 'workspace', 'flows', 'gone')));

    await client.close();
    control.stop();

    console.log(failures === 0 ? 'MCPCHECK OK' : `MCPCHECK FAILED — ${failures} check(s)`);
    app.exit(failures === 0 ? 0 : 1);
}

void app.whenReady().then(() =>
    main().catch((e: unknown) => {
        console.error('MCPCHECK FAILED:', e instanceof Error ? e.stack : e);
        app.exit(1);
    }),
);
