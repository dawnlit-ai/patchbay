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
import { mkdtempSync } from 'node:fs';
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

    const settings = await call('get_settings');
    check('the token is withheld', settings.includes('(withheld)') && !settings.includes(TOKEN));

    await call('get_status');
    await call('list_runs', { limit: 3 });
    await call('get_flow', { flowId });
    await call('delete_flow', { flowId });

    const missing = await client.callTool({ name: 'get_flow', arguments: { flowId: 'gone' } });
    check('a missing flow comes back as a readable error', missing.isError === true);

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
