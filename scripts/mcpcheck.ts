/**
 * Smoke test for the agent-control MCP server, under Electron against throwaway
 * app data and workspaces in the temp folder. Calls neither Outlook nor Claude,
 * so it is free to run.
 *
 *   npm run mcpcheck
 */
import { app } from 'electron';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { WorkspaceChange } from '../src/shared/ipc';
import type { EngineStatus } from '../src/shared/settings';

/** Not the default port: a check should not fight the app if it is running. */
const PORT = 8799;
const TOKEN = 'mcpcheck-token';

const data = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-'));
app.setPath('userData', data);

let failures = 0;

function check(what: string, ok: boolean, detail = ''): void {
    if (!ok) failures += 1;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
    // Imported here rather than at the top, so the app data above is already
    // redirected by the time anything resolves a path inside it.
    const {getSettings, saveSettings} = await import('../src/main/store/settingsStore');
    const {AgentControl} = await import('../src/main/mcp/server');
    const {Watcher} = await import('../src/main/engine/watcher');
    const {duplicateFlow, getFlow, importFlowFile, saveFlowFrom, setFlowFileName} = await import(
        '../src/main/store/flowStore'
        );
    const {createSkill, listSkills, locateSkill, missingSkills, workspaceSkillPlugin} = await import(
        '../src/main/store/skillStore'
        );
    const {stopWatchingFolders, watchFolders} = await import('../src/main/store/folderWatch');
    const {listMcpServers, requireServer, setServerTrust, usableServers} = await import('../src/main/store/mcpStore');
    const {withToolPath} = await import('../src/main/agents/toolPath');
    const {createReadme, createWorkspace, openWorkspace, readReadme} = await import('../src/main/store/workspaceStore');

    console.log('app data:', data);
    saveSettings({...getSettings(), agentControl: {enabled: true, port: PORT, token: TOKEN}});

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
        headers: {'content-type': 'application/json', authorization: 'Bearer wrong'},
        body: '{}',
    });
    check('a wrong token is refused', refused.status === 401, `HTTP ${refused.status}`);

    const client = new Client({name: 'mcpcheck', version: '1.0.0'});
    await client.connect(
        new StreamableHTTPClientTransport(new URL(status.url), {
            requestInit: {headers: {authorization: `Bearer ${TOKEN}`}},
        }),
    );

    const {tools} = await client.listTools();
    check(`${tools.length} tools listed`, tools.length > 0);

    /** Calls a tool and returns its text, failing the check if it errored. */
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
        const result = await client.callTool({name, arguments: args});
        const text = (result.content as { type: string; text?: string }[])
            .map((part) => part.text ?? `[${part.type}]`)
            .join('\n');
        check(name, result.isError !== true, result.isError ? text.slice(0, 200) : '');
        return text;
    };

    const none = await client.callTool({name: 'list_flows', arguments: {}});
    check(
        'with no workspace open, a tool says so',
        none.isError === true && JSON.stringify(none.content).includes('No workspace is open'),
    );

    // A new workspace is a folder of its own in the location, with a flows folder
    // and a starter skill, and becomes the open one.
    const home = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-home-'));
    const root = createWorkspace('Checked workspace', home).path;
    console.log('workspace:', root);
    check(
        'a new workspace gets a folder named after it, a flows folder and a starter skill',
        root === join(home, 'checked-workspace') &&
        existsSync(join(root, 'flows')) &&
        existsSync(join(root, 'skills', 'summarize-and-file', 'SKILL.md')),
    );
    check('a second of the same name is numbered past it', createWorkspace('Checked workspace', home).path === join(home, 'checked-workspace-2'));
    openWorkspace(root);
    check('get_workspace names the one open', (JSON.parse(await call('get_workspace')) as {
        path: string
    }).path === root);

    const flowId = (JSON.parse(await call('create_flow', {name: 'Wired by an agent'})) as { id: string }).id;
    check(
        'a new flow is a file in the workspace’s flows folder, named after it',
        (JSON.parse(await call('list_flows')) as { id: string; file: string }[]).find((f) => f.id === flowId)?.file ===
        join(root, 'flows', 'wired-by-an-agent.json'),
    );
    const idOf = async (kind: string, name?: string): Promise<string> =>
        (JSON.parse(await call('add_node', {flowId, kind, ...(name ? {name} : {})})) as { id: string }).id;

    const trigger = await idOf('trigger.outlook', 'Invoices');
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
                {id: 'invoice', label: 'Invoice', description: 'A supplier invoice asking to be paid.'},
                {id: 'support', label: 'Support', description: 'A customer asking for help with an order.'},
            ],
            bodyMaxChars: 'not a number',
        },
    });
    check('a bad value falls back to its default', patched.includes('"bodyMaxChars": 8000'));

    const ending = await call('update_node', {
        flowId,
        nodeId: done,
        config: {disposition: 'needs-review'},
    });
    check('a terminal records its disposition', ending.includes('"disposition": "needs-review"'));

    const step = await call('add_node', {flowId, kind: 'processor'});
    check(
        'a new processor starts with no server tools and no file-system access',
        step.includes('"mcpTools": []') && step.includes('"allowFileSystem": false'),
    );
    const widened = await call('update_node', {
        flowId,
        nodeId: (JSON.parse(step) as { id: string }).id,
        config: {mcpTools: 'mcp__everything'},
    });
    check('a tool list of the wrong type narrows to nothing', widened.includes('"mcpTools": []'));

    const pull = await call('add_node', {flowId, kind: 'extractor'});
    const puller = (JSON.parse(pull) as { id: string }).id;
    check(
        'a new extractor starts with no skills, inputs or server tools',
        pull.includes('"skills": []') && pull.includes('"inputs": []') && pull.includes('"mcpTools": []'),
    );
    const reading = await call('update_node', {
        flowId,
        nodeId: puller,
        config: {inputs: ['order'], mcpTools: ['mcp__crm__lookup']},
    });
    check(
        'an extractor keeps the slots and server tools it names',
        reading.includes('"order"') && reading.includes('"mcp__crm__lookup"'),
    );

    // An Extractor reading a slot no path fills is flagged, as a Processor is.
    const lone = (JSON.parse(await call('create_flow', {name: 'Extractor reads too much'})) as { id: string }).id;
    const loneTrigger = (JSON.parse(await call('add_node', {flowId: lone, kind: 'trigger.outlook'})) as {
        id: string
    }).id;
    const lonePuller = (JSON.parse(await call('add_node', {flowId: lone, kind: 'extractor'})) as { id: string }).id;
    await call('update_node', {flowId: lone, nodeId: lonePuller, config: {inputs: ['order']}});
    await call('connect', {flowId: lone, from: loneTrigger, port: 'out', to: lonePuller});
    check(
        'an extractor reading a slot no path fills is flagged',
        (await call('get_flow', {flowId: lone})).includes('reads \\"order\\", but not every path here fills it'),
    );
    await call('delete_flow', {flowId: lone});

    await call('connect', {flowId, from: trigger, port: 'out', to: sorter});
    await call('connect', {flowId, from: sorter, port: 'cat:invoice', to: done});

    const wrongPort = await client.callTool({
        name: 'connect',
        arguments: {flowId, from: trigger, port: 'nonsense', to: done},
    });
    check('a port that does not exist is refused', wrongPort.isError === true);

    // Dropping the category takes the edge that left its port with it.
    const dropped = await call('update_node', {
        flowId,
        nodeId: sorter,
        config: {categories: [{id: 'support', label: 'Support', description: 'A request for help.'}]},
    });
    check('an edge left hanging is dropped and reported', dropped.includes('"droppedEdges": 1'));

    // A schema named once is the workspace's: a file in its schemas folder, which a
    // node in any flow can pick, and which a rename carries through every flow
    // naming it.
    const schemaFile = (name: string): string => join(root, 'schemas', `${name}.json`);
    const fileOf = async (id: string): Promise<string> =>
        readFileSync(
            (JSON.parse(await call('list_flows')) as {
                id: string;
                file: string
            }[]).find((f) => f.id === id)?.file ?? '',
            'utf8',
        );
    const settingsShape = {type: 'object', properties: {output_dir: {type: 'string'}}, required: ['output_dir']};
    await call('set_schema', {name: 'Settings', schema: settingsShape});
    await call('set_schema', {
        name: 'Shipment',
        schema: {
            type: 'object',
            properties: {bl_no: {type: 'string'}, settings: {$ref: '#/schemas/Settings', description: 'Its own.'}},
            required: ['bl_no', 'settings'],
        },
    });
    check(
        'a named schema is a file in the workspace’s schemas folder',
        existsSync(schemaFile('Settings')) && existsSync(schemaFile('Shipment')),
    );
    const shipmentRef = {$ref: '#/schemas/Shipment'};
    await call('update_node', {flowId, nodeId: puller, config: {schema: shipmentRef}});
    const sharer = (JSON.parse(await call('create_flow', {name: 'Shares a schema'})) as { id: string }).id;
    const secondIn = (JSON.parse(await call('add_node', {flowId: sharer, kind: 'trigger.outlook'})) as {
        id: string
    }).id;
    const secondPuller = (JSON.parse(await call('add_node', {flowId: sharer, kind: 'extractor'})) as { id: string }).id;
    await call('update_node', {flowId: sharer, nodeId: secondPuller, config: {schema: shipmentRef}});
    await call('connect', {flowId: sharer, from: secondIn, port: 'out', to: secondPuller});
    const usedBy = (listing: string, name: string): number | undefined =>
        (JSON.parse(listing) as { name: string; usedBy: unknown[] }[]).find((s) => s.name === name)?.usedBy.length;
    const listing = await call('list_schemas');
    check(
        'a node in any flow can use one, and through it the schemas it holds',
        usedBy(listing, 'Shipment') === 2 && usedBy(listing, 'Settings') === 2,
    );
    check('and the flow is fine with it', !(await call('get_flow', {flowId: sharer})).includes('cannot be used'));
    const caseOnly = await client.callTool({name: 'set_schema', arguments: {name: 'shipment', schema: settingsShape}});
    check('a name that differs only in case is refused', caseOnly.isError === true);
    await call('rename_schema', {name: 'Settings', to: 'Config'});
    check(
        'renaming one renames its file, and the schemas holding it follow',
        !existsSync(schemaFile('Settings')) && readFileSync(schemaFile('Shipment'), 'utf8').includes('#/schemas/Config'),
    );
    await call('rename_schema', {name: 'Shipment', to: 'Cargo'});
    check(
        'and so does every flow naming it',
        (await fileOf(flowId)).includes('#/schemas/Cargo') &&
        (await fileOf(sharer)).includes('#/schemas/Cargo') &&
        !(await fileOf(sharer)).includes('#/schemas/Shipment'),
    );
    // No node keeps a schema of its own, so there is nowhere a copy of a deleted one
    // could go: deleting one is refused while anything names it.
    const refusal = async (name: string): Promise<string | null> => {
        const result = await client.callTool({name: 'delete_schema', arguments: {name}});
        return result.isError === true ? JSON.stringify(result.content) : null;
    };
    const heldBy = await refusal('Config');
    check(
        'a schema another is built from is not deleted, and the refusal names it',
        heldBy !== null && heldBy.includes('the schema Cargo') && existsSync(schemaFile('Config')),
    );
    const namedBy = await refusal('Cargo');
    check(
        'nor one a node names, and the refusal names the flow and the node',
        namedBy !== null && namedBy.includes('Shares a schema') && existsSync(schemaFile('Cargo')),
    );
    await call('update_node', {flowId: sharer, nodeId: secondPuller, config: {schema: {}}});
    await call('update_node', {flowId, nodeId: puller, config: {schema: {}}});
    await call('delete_schema', {name: 'Cargo'});
    await call('delete_schema', {name: 'Config'});
    check('once nothing names it, it goes', !existsSync(schemaFile('Cargo')) && !existsSync(schemaFile('Config')));
    check(
        'a node naming no schema is flagged',
        (await call('get_flow', {flowId: sharer})).includes('has no schema yet'),
    );
    const ownShape = await client.callTool({
        name: 'update_node',
        arguments: {flowId: sharer, nodeId: secondPuller, config: {schema: settingsShape}},
    });
    check(
        'an agent cannot give a node a schema of its own',
        ownShape.isError === true && JSON.stringify(ownShape.content).includes('never holds a schema of its own'),
    );
    await call('update_node', {flowId: sharer, nodeId: secondPuller, config: {schema: {$ref: '#/schemas/Nope'}}});
    check(
        'a node naming a schema the workspace lacks is flagged',
        (await call('get_flow', {flowId: sharer})).includes('the workspace has no schema \\"Nope\\"'),
    );
    await call('delete_flow', {flowId: sharer});

    await call('write_skill', {
        name: 'check-skill',
        content: '---\nname: check-skill\ndescription: A skill written over MCP.\n---\n\nDo the thing.\n',
    });
    check(
        'the skill is in the workspace’s library',
        (await call('list_skills')).includes('check-skill') && existsSync(join(root, 'skills', 'check-skill', 'SKILL.md')),
    );

    // A skill is a folder, not a file: what sits beside SKILL.md has to come too.
    const shelf = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-skills-'));
    for (const name of ['alpha', 'beta']) {
        mkdirSync(join(shelf, name, 'references'), {recursive: true});
        writeFileSync(
            join(shelf, name, 'SKILL.md'),
            `---\nname: ${name}\ndescription: Imported over MCP.\n---\n\nRead references/notes.md.\n`,
        );
        writeFileSync(join(shelf, name, 'references', 'notes.md'), 'A file beside the SKILL.md.\n');
    }
    const imported = JSON.parse(await call('import_skills', {dir: shelf, names: ['alpha', 'nope']})) as {
        imported: string[];
        notFound?: string[];
    };
    check(
        'only the named skill is imported, and a missing one is named',
        imported.imported.join() === 'alpha' && imported.notFound?.join() === 'nope',
    );
    check(
        'the files beside SKILL.md come with it',
        existsSync(join(root, 'skills', 'alpha', 'references', 'notes.md')),
    );
    const itself = await client.callTool({name: 'import_skills', arguments: {dir: join(shelf, 'alpha')}});
    check('a skill folder passed as the shelf is refused', itself.isError === true);
    const relative = await client.callTool({name: 'import_skills', arguments: {dir: 'skills'}});
    check('a relative folder is refused', relative.isError === true);

    // Every flow ticks the one library by name.
    const worker = await idOf('processor');
    await call('update_node', {flowId, nodeId: worker, config: {skills: ['alpha']}});
    const other = (JSON.parse(await call('create_flow', {name: 'Also ticks alpha'})) as { id: string }).id;
    const otherWorker = (JSON.parse(await call('add_node', {flowId: other, kind: 'processor'})) as { id: string }).id;
    await call('update_node', {flowId: other, nodeId: otherWorker, config: {skills: ['alpha']}});
    const gone = await call('delete_skill', {name: 'alpha'});
    check(
        'deleting a skill names every flow still ticking it',
        gone.includes('Wired by an agent') && gone.includes('Also ticks alpha'),
        gone,
    );
    await call('delete_flow', {flowId: other});
    await call('import_skills', {dir: shelf, names: ['alpha']});

    // A run gets a copy of every skill in the workspace, whatever its node ticks, as a plugin.
    const plugin = workspaceSkillPlugin();
    const everySkill = listSkills().map((s) => s.name);
    check(
        'a run gets every skill in the workspace, folder and all, as a plugin',
        plugin !== null &&
        existsSync(join(plugin.path, '.claude-plugin', 'plugin.json')) &&
        existsSync(join(plugin.path, 'skills', 'alpha', 'references', 'notes.md')) &&
        everySkill.every((name) => existsSync(join(plugin.path, 'skills', name, 'SKILL.md'))) &&
        JSON.stringify(plugin.names) === JSON.stringify(everySkill) &&
        readdirSync(join(plugin.path, 'skills')).length === everySkill.length,
        plugin?.names.join(', '),
    );
    if (!plugin) throw new Error('no plugin to check');
    plugin.dispose();
    check(
        'the run’s copy goes, and the library stays',
        !existsSync(plugin.path) && existsSync(join(root, 'skills', 'alpha', 'SKILL.md')),
    );
    // Under Electron, rmSync follows a junction and empties its target.
    const outside = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-outside-'));
    writeFileSync(join(outside, 'keep.md'), 'Not the skill’s to delete.\n');
    await call('write_skill', {name: 'zeta', content: '---\nname: zeta\ndescription: Linked.\n---\n'});
    symlinkSync(outside, join(root, 'skills', 'zeta', 'shared'), 'junction');
    await call('delete_skill', {name: 'zeta'});
    check(
        'deleting a skill removes a link inside it, not what it points at',
        !existsSync(join(root, 'skills', 'zeta')) && existsSync(join(outside, 'keep.md')),
    );

    // Skills are edited and deleted in other apps while this one runs. The library
    // is watched, but not the rest of the workspace, and what went is refused by
    // name, not failed on.
    let heard = 0;
    let lastHeard: WorkspaceChange | null = null;
    watchFolders((change) => {
        heard += 1;
        lastHeard = change;
    });
    const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const heardAfter = async (act: () => void): Promise<boolean> => {
        await pause(500);
        const before = heard;
        act();
        for (let i = 0; i < 30 && heard === before; i++) await pause(100);
        return heard > before;
    };
    check(
        'a skill saved in the library is heard',
        await heardAfter(() =>
            writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Saved elsewhere.\n---\n'),
        ),
    );
    check(
        'a file elsewhere in the workspace is not',
        !(await heardAfter(() => writeFileSync(join(root, 'scratch.txt'), 'Not a skill.\n'))),
    );
    check(
        'a skill deleted in the library is heard',
        await heardAfter(() => rmSync(join(root, 'skills', 'check-skill'), {recursive: true})),
    );
    // So are schemas, and what is heard says which.
    check(
        'a schema saved in its folder is heard, as a schema',
        (await heardAfter(() => writeFileSync(schemaFile('Kept'), JSON.stringify({type: 'object', properties: {}})))) &&
        (lastHeard as WorkspaceChange | null)?.schemas === true,
    );
    // And the files other tools keep MCP servers in, at the top of the workspace
    // or in a folder of theirs that did not exist when watching began.
    check(
        'a .mcp.json saved at the top of the workspace is heard, as MCP',
        (await heardAfter(() => writeFileSync(join(root, '.mcp.json'), '{"mcpServers": {}}\n'))) &&
        (lastHeard as WorkspaceChange | null)?.mcp === true,
    );
    mkdirSync(join(root, '.vscode'));
    check(
        'and a .vscode/mcp.json, in a folder made after watching began',
        await heardAfter(() => writeFileSync(join(root, '.vscode', 'mcp.json'), '{"servers": {}}\n')),
    );
    stopWatchingFolders();
    rmSync(join(root, '.mcp.json'));
    rmSync(join(root, '.vscode'), {recursive: true});
    let refusedByName = '';
    try {
        locateSkill('check-skill');
    } catch (e) {
        refusedByName = (e as Error).message;
    }
    check('opening a skill deleted elsewhere is refused by name', refusedByName.includes('“check-skill” is no longer'));
    check(
        'a tick naming a skill deleted elsewhere is found',
        missingSkills(['alpha', 'check-skill']).join() === 'check-skill',
    );
    mkdirSync(join(root, 'skills', 'hollow', 'SKILL.md'), {recursive: true});
    let listed: string[] = [];
    try {
        listed = listSkills().map((s) => s.name);
    } catch {
        // Checked below.
    }
    check('a skill that cannot be read is left out of the list, not failing it', listed.includes('alpha') && !listed.includes('hollow'));
    let replaced = true;
    try {
        createSkill('alpha', '---\nname: alpha\ndescription: Would replace.\n---\n');
    } catch {
        replaced = false;
    }
    check(
        'creating a skill does not replace one of that name',
        !replaced && readFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), 'utf8').includes('Saved elsewhere.'),
    );

    // A run has an id from the moment it is queued. A trigger wired to nothing
    // ends its path at once, so these runs touch neither Outlook nor Claude; two
    // of one flow queued together means the second waits for the first.
    const lane = (JSON.parse(await call('create_flow', {name: 'Queue check'})) as { id: string }).id;
    const start = (JSON.parse(await call('add_node', {flowId: lane, kind: 'trigger.outlook'})) as { id: string }).id;
    const email = {
        ref: {entryId: 'mcpcheck', storeId: 'mcpcheck', account: 'check@example.com', folderPath: ''},
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
    check('the run ahead of it still ran', (await call('get_run', {runId: first})).includes('"status": "completed"'));
    check('list_runs has it', (await call('list_runs', {flowId: lane})).includes(first));
    check(
        'cancel_run says when there is nothing to cancel',
        (await call('cancel_run', {runId: second})).includes('Nothing to cancel'),
    );

    // A step whose skill was deleted since it was ticked stops at its error port,
    // naming the skill, before Claude is asked anything.
    const stranded = (JSON.parse(await call('create_flow', {name: 'Lost skill check'})) as { id: string }).id;
    const inbox = (JSON.parse(await call('add_node', {flowId: stranded, kind: 'trigger.outlook'})) as {
        id: string
    }).id;
    const orphan = (JSON.parse(await call('add_node', {flowId: stranded, kind: 'processor'})) as { id: string }).id;
    await call('update_node', {flowId: stranded, nodeId: orphan, config: {skills: ['check-skill']}});
    await call('connect', {flowId: stranded, from: inbox, port: 'out', to: orphan});
    const lostRun = watcher.enqueueManual(stranded, inbox, email);
    for (let i = 0; i < 50 && watcher.status().activeRunIds.length > 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
    }
    const lostTrace = await call('get_run', {runId: lostRun});
    check(
        'a step ticking a skill deleted since leaves by its error port, naming it',
        lostTrace.includes('“check-skill” is ticked but no longer in the workspace'),
    );
    await call('delete_flow', {flowId: stranded});

    // A canvas saves against the version it last read. Its own saves move that
    // on; anyone else's write means its edit was made to a flow no longer there.
    const loaded = getFlow(lane);
    if (!loaded) throw new Error('the queue check flow is missing');
    const once = saveFlowFrom('canvas', {...loaded, name: 'Edited once'});
    const twice = saveFlowFrom('canvas', {...loaded, name: 'Edited twice'});
    check('a canvas saving twice from one read is not refused by its own save', 'saved' in once && 'saved' in twice);
    await call('rename_flow', {flowId: lane, name: 'Renamed by an agent'});
    const overtaken = saveFlowFrom('canvas', {...loaded, name: 'Edited a third time'});
    check(
        'a canvas edit made before an agent’s write is refused, and handed what is there',
        'current' in overtaken && overtaken.current?.name === 'Renamed by an agent',
    );
    check('the agent’s write stands', getFlow(lane)?.name === 'Renamed by an agent');
    const reread = getFlow(lane);
    check(
        'an edit to the flow as it now stands is saved',
        reread !== null && 'saved' in saveFlowFrom('canvas', {...reread, name: 'Edited after reading'}),
    );
    const laneFile = join(root, 'flows', 'queue-check.json');
    check('a renamed flow keeps its file', existsSync(laneFile));
    await call('delete_flow', {flowId: lane});
    const late = reread ? saveFlowFrom('canvas', {...reread, name: 'Too late'}) : null;
    // What a canvas still showing the flow does next: refresh its skill list.
    listSkills();
    check(
        'a save to a deleted flow, or a look at the skills, does not bring it back',
        late !== null && 'current' in late && late.current === null && getFlow(lane) === null && !existsSync(laneFile),
    );

    // A flow file from elsewhere is copied in, as a file of its own named after the flow.
    const elsewhere = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-elsewhere-'));
    const sent = join(elsewhere, 'sent.json');
    writeFileSync(
        sent,
        JSON.stringify({
            name: 'Sent over',
            nodes: [],
            edges: [],
        }),
    );
    const brought = importFlowFile(sent);
    const sentOver = join(root, 'flows', 'sent-over.json');
    check('an imported flow is copied into flows, named after it', existsSync(sentOver) && getFlow(brought.id)?.name === 'Sent over');
    check('and the file it came from is left as it was', !('id' in (JSON.parse(readFileSync(sent, 'utf8')) as object)));
    check(
        'importing it again is another flow, in a file numbered past the first',
        importFlowFile(sent).id !== brought.id && existsSync(join(root, 'flows', 'sent-over-2.json')),
    );
    const withId = join(elsewhere, 'with-id.json');
    copyFileSync(sentOver, withId);
    check('a file carrying an id this workspace has gets one of its own', importFlowFile(withId).id !== brought.id);
    check('importing a file already listed is that flow', importFlowFile(sentOver).id === brought.id);
    const byHand = join(root, 'flows', 'zz-copied-by-hand.json');
    copyFileSync(sentOver, byHand);
    const adopted = importFlowFile(byHand);
    check(
        'a copy made by hand in flows gets an id of its own, where it is',
        adopted.id !== brought.id &&
        (JSON.parse(readFileSync(byHand, 'utf8')) as { id: string }).id === adopted.id &&
        readdirSync(join(root, 'flows')).length === 5,
        readdirSync(join(root, 'flows')).join(', '),
    );

    // Its file can be renamed, and its id, and so its runs, stay with it.
    setFlowFileName(brought.id, 'Renamed by hand');
    check(
        'renaming a flow’s file keeps its id',
        existsSync(join(root, 'flows', 'renamed-by-hand.json')) && !existsSync(sentOver) && getFlow(brought.id) !== null,
    );
    let clashed = false;
    try {
        setFlowFileName(adopted.id, 'renamed-by-hand');
    } catch {
        clashed = true;
    }
    check('a file name another flow has is refused', clashed);
    const original = getFlow(brought.id);
    const duplicate = original ? duplicateFlow(original, 'Sent over') : null;
    check(
        'a duplicate is a flow of its own, in a file of its own',
        duplicate !== null && duplicate.id !== brought.id && existsSync(sentOver),
    );
    for (const id of [brought.id, adopted.id, duplicate?.id]) if (id) await call('delete_flow', {flowId: id});
    check('deleting flows leaves the skills', existsSync(join(root, 'skills', 'alpha', 'SKILL.md')));
    rmSync(elsewhere, {recursive: true, force: true});

    // One workspace is open at a time, and each has its own flows, skills and runs.
    const away = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-away-'));
    openWorkspace(away);
    check(
        'another workspace lists only its own flows, skills and schemas',
        (JSON.parse(await call('list_flows')) as unknown[]).length === 0 &&
        (JSON.parse(await call('list_skills')) as unknown[]).length === 0 &&
        (JSON.parse(await call('list_schemas')) as unknown[]).length === 0,
    );
    check('and only its own runs', !(await call('list_runs', {limit: 50})).includes(first));
    check('a run there gets no skills: none come from the other workspace, or from anywhere else', workspaceSkillPlugin() === null);
    check('and looking writes nothing into its folder', readdirSync(away).length === 0);
    openWorkspace(root);
    check(
        'coming back finds them where they were',
        (await call('list_runs', {limit: 50})).includes(first) && (await call('list_flows')).includes(flowId),
    );
    rmSync(away, {recursive: true, force: true});

    // A README is optional, at the top of the workspace, started from a template, and found in whatever case it is spelled.
    const readmeOf = async (): Promise<string | null> =>
        (JSON.parse(await call('get_workspace')) as { readme: string | null }).readme;
    check('a workspace has no README until one is written', readReadme() === null && (await readmeOf()) === null);
    const readme = createReadme();
    const started = readReadme()?.content ?? '';
    check(
        'a README starts from a template naming the workspace and its flows',
        readme === join(root, 'README.md') &&
        started.startsWith('# checked-workspace\n') &&
        started.includes('**Wired by an agent**'),
    );
    check('get_workspace points an agent at it', (await readmeOf()) === readme);
    let rewritten = false;
    try {
        createReadme();
        rewritten = true;
    } catch {
        // Refused, as it should be.
    }
    check('a second is refused rather than written over the first', !rewritten && readReadme()?.content === started);
    renameSync(readme, join(root, 'readme.md'));
    check('one spelled in lower case is found too', readReadme()?.path === join(root, 'readme.md'));
    renameSync(join(root, 'readme.md'), join(root, 'notes.md'));
    writeFileSync(join(root, 'flows', 'README.md'), '# The flows folder’s own\n');
    check('a README inside the flows folder is not the workspace’s', readReadme() === null);
    rmSync(join(root, 'flows', 'README.md'));

    // The console: what the app did outside any one run, this session's and a day's.
    check(
        'the console shows an agent’s calls',
        (await call('get_console', {source: 'agent'})).includes('Called create_flow'),
    );
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    check(
        'a day’s file reads back',
        (await call('get_console', {day: today, source: 'run'})).includes('Cancelled before it started'),
    );
    const notADay = await client.callTool({name: 'get_console', arguments: {day: 'yesterday'}});
    check('a day that is not a date is refused', notADay.isError === true);

    const settings = await call('get_settings');
    check('the token is withheld', settings.includes('(withheld)') && !settings.includes(TOKEN));

    // Workspace MCP server auto-detection, precedence and trust.
    process.env.PATCHBAY_MCPCHECK_TOKEN = TOKEN;
    writeFileSync(
        join(root, '.mcp.json'),
        JSON.stringify({
            mcpServers: {
                loopback: {
                    type: 'http',
                    url: `http://127.0.0.1:${PORT}/mcp`,
                    headers: {Authorization: 'Bearer ${PATCHBAY_MCPCHECK_TOKEN:-none}'},
                },
                local: {
                    command: 'node',
                    args: ['${workspaceFolder}/server.js', '${PATCHBAY_UNSET_DEFAULT:---ok}'],
                },
                email: {command: 'node', args: ['taken.js']},
                missingEnv: {command: 'node', args: ['${PATCHBAY_NEVER_SET}']},
            },
        }),
    );
    mkdirSync(join(root, '.vscode'), {recursive: true});
    writeFileSync(
        join(root, '.vscode', 'mcp.json'),
        `{
            // VS Code's own shape, with comments and a trailing comma.
            "servers": {
                "local": { "command": "node", "args": ["shadowed.js"], },
                "vscodeOnly": { "command": "npx", "args": ["-y", "some-mcp"], },
            },
        }`,
    );
    const detected = listMcpServers();
    const byName = (name: string) => detected.servers.filter((s) => s.name === name);
    check(
        '.mcp.json and .vscode/mcp.json are both read, including JSONC comments and trailing commas',
        byName('loopback')[0]?.state === 'new' && byName('vscodeOnly')[0]?.state === 'new',
    );
    check(
        '.mcp.json takes precedence over .vscode/mcp.json for the same server name',
        byName('local')[0]?.source === '.mcp.json' &&
        byName('local')[0]?.state === 'new' &&
        byName('local')[1]?.source === '.vscode/mcp.json' &&
        byName('local')[1]?.state === 'shadowed',
    );
    check(
        'reserved server name "email" and missing env variables are flagged as invalid',
        byName('email')[0]?.state === 'invalid' && byName('missingEnv')[0]?.state === 'invalid',
    );
    check('untrusted workspace servers are not usable until allowed', usableServers().size === 0);
    const beforeTrust = await client.callTool({name: 'list_server_tools', arguments: {server: 'loopback'}});
    check('list_server_tools refuses a workspace server that has not been allowed', beforeTrust.isError === true);

    setServerTrust('loopback', true);
    setServerTrust('local', true);
    const localLaunch = usableServers().get('local')?.launch;
    check(
        'allowing a workspace server expands ${workspaceFolder} and ${VAR:-default} and sets cwd to the workspace',
        localLaunch?.type === 'stdio' &&
        localLaunch.args?.[0] === `${root}/server.js` &&
        localLaunch.args?.[1] === '--ok' &&
        localLaunch.cwd === root,
    );
    const loopbackTools = await call('list_server_tools', {server: 'loopback'});
    check(
        'an allowed HTTP workspace server with expanded Authorization header lists its tools',
        loopbackTools.includes('mcp__loopback__list_flows'),
    );

    // Editing .mcp.json invalidates the approval until allowed again.
    writeFileSync(
        join(root, '.mcp.json'),
        JSON.stringify({
            mcpServers: {
                loopback: {type: 'http', url: `http://127.0.0.1:${PORT}/mcp`},
                local: {command: 'node', args: ['different.js']},
            },
        }),
    );
    const afterEdit = listMcpServers();
    check(
        'changing a server command in .mcp.json requires allowing it again',
        afterEdit.servers.find((s) => s.name === 'local' && s.source === '.mcp.json')?.state === 'changed' &&
        !usableServers().has('local'),
    );
    setServerTrust('local', false);
    check(
        'blocking a workspace server records it as blocked',
        listMcpServers().servers.find((s) => s.name === 'local' && s.source === '.mcp.json')?.state === 'blocked',
    );
    const settingsWithWorkspace = await call('get_settings');
    check(
        'get_settings lists workspace MCP servers without exposing header values',
        settingsWithWorkspace.includes('"workspaceMcpServers"') && !settingsWithWorkspace.includes(TOKEN),
    );

    // A ticked server no run can be handed says what stands in its way: a node
    // that ticks it stops at its error port with that.
    const whyRefused = (name: string): string => {
        try {
            requireServer(name);
            return '';
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    };
    check('a server defined nowhere is refused by name', whyRefused('nowhere').includes('no MCP server "nowhere"'));
    check('a blocked workspace server is refused as not allowed', whyRefused('local').includes('not allowed'));
    check('one never allowed says it has not been', whyRefused('vscodeOnly').includes('has not been allowed'));

    // The same two as before, so what was decided about them stands, and one more by address.
    writeFileSync(
        join(root, '.mcp.json'),
        JSON.stringify({
            mcpServers: {
                loopback: {type: 'http', url: `http://127.0.0.1:${PORT}/mcp`},
                local: {command: 'node', args: ['different.js']},
                remote: {
                    type: 'http',
                    url: `http://127.0.0.1:${PORT}/mcp`,
                    headers: {Authorization: 'Bearer ${PATCHBAY_MCPCHECK_TOKEN}'},
                },
            },
        }),
    );
    setServerTrust('remote', true);
    const remote = usableServers().get('remote')?.launch;
    check(
        'an HTTP workspace server is handed over by address, with its headers filled in',
        remote?.type === 'http' && remote.url.endsWith(`:${PORT}/mcp`) && remote.headers?.Authorization === `Bearer ${TOKEN}`,
    );
    check(
        'and lists its tools',
        (await call('list_server_tools', {server: 'remote'})).includes('mcp__remote__list_flows'),
    );
    const settingsWithHeaders = await call('get_settings');
    check(
        'get_settings names its header but withholds the value',
        settingsWithHeaders.includes('"Authorization"') && !settingsWithHeaders.includes(TOKEN),
    );

    // Settings holds no servers of its own. One an older settings file kept, with
    // the secret in its env, leaves the file, and no run can be handed it.
    const {settingsFile} = await import('../src/main/paths');
    saveSettings({
        ...getSettings(),
        mcpServers: [{name: 'old', command: 'node', args: [], env: {OLD_TOKEN: 'mcpcheck-old-secret'}, enabled: true}],
    } as ReturnType<typeof getSettings>);
    const onDisk = readFileSync(settingsFile(), 'utf8');
    check(
        'a server an older Settings kept is dropped from the file, its env values with it',
        !onDisk.includes('mcpServers') && !onDisk.includes('mcpcheck-old-secret') && !('mcpServers' in getSettings()),
    );
    check('and is not a server a node can be handed', whyRefused('old').includes('no MCP server "old"'));

    // Opened from the Finder, the app has launchd's PATH: what starts a server —
    // the listing above, or the agent a run hands it to — gets the folders npx,
    // uvx and node are installed in as well.
    if (process.platform !== 'win32') {
        const launchd = '/usr/bin:/bin:/usr/sbin:/sbin';
        const extended = withToolPath({PATH: launchd, HOME: '/home/check'});
        check(
            'a launchd PATH gains Homebrew’s and ~/.local/bin after its own, the rest of the environment kept',
            extended.PATH?.startsWith(`${launchd}:`) === true &&
            extended.PATH.split(':').includes('/opt/homebrew/bin') &&
            extended.PATH.split(':').includes('/usr/local/bin') &&
            extended.HOME === '/home/check',
        );
        check('and one that has them all is left as it is', withToolPath({PATH: extended.PATH}).PATH === extended.PATH);
    }

    // Refused before any poll, so Outlook is never reached.
    const unwatchable = await client.callTool({name: 'start_watching', arguments: {flowId}});
    check('a flow whose trigger names no mailbox is not switched on', unwatchable.isError === true);
    check('nothing is being watched', (JSON.parse(await call('get_status')) as EngineStatus).flowIds.length === 0);
    await call('list_runs', {limit: 3});
    await call('get_flow', {flowId});
    await call('delete_flow', {flowId});

    const missing = await client.callTool({name: 'get_flow', arguments: {flowId: 'gone'}});
    check('a missing flow comes back as a readable error', missing.isError === true);
    check('and asking after it leaves no file behind', !existsSync(join(root, 'flows', 'gone.json')));

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
