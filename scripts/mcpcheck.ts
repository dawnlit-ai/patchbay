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
    const {stopWatchingSkills, watchSkills} = await import('../src/main/store/skillWatch');
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

    // Terminals do nothing to the email, so any actions written onto one are dropped.
    const ending = await call('update_node', {
        flowId,
        nodeId: done,
        config: {disposition: 'needs-review', actions: [{type: 'move', folder: 'Processed'}]},
    });
    const ended = (JSON.parse(ending) as { node: { config: Record<string, unknown> } }).node.config;
    check(
        'a terminal keeps its disposition and drops any actions',
        ended.disposition === 'needs-review' && !('actions' in ended),
        JSON.stringify(ended),
    );

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

    // Every flow ticks the one library by name. A tick a flow saved while there were
    // two libraries, `global:<name>`, reads as the name.
    const worker = await idOf('processor');
    await call('update_node', {flowId, nodeId: worker, config: {skills: ['alpha']}});
    await call('update_node', {flowId, nodeId: puller, config: {skills: ['global:alpha', 'alpha']}});
    const ticks = (JSON.parse(await call('get_flow', {flowId})) as {
        nodes: { id: string; config: { skills?: string[] } }[];
    }).nodes.find((n) => n.id === puller)?.config.skills;
    check('an old global: tick reads as the skill’s name, once', ticks?.join() === 'alpha', JSON.stringify(ticks));
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
    watchSkills(() => {
        heard += 1;
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
    stopWatchingSkills();
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

    // A flow file from elsewhere is copied in, as a file of its own named after the
    // flow, and the skills it carries go into the library, never over one there.
    const elsewhere = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-elsewhere-'));
    const sent = join(elsewhere, 'sent.json');
    writeFileSync(
        sent,
        JSON.stringify({
            name: 'Sent over',
            nodes: [],
            edges: [],
            skills: [
                {name: 'carried', content: '---\nname: carried\ndescription: Came in the file.\n---\n'},
                {name: 'alpha', content: '---\nname: alpha\ndescription: Would replace.\n---\n'},
            ],
        }),
    );
    const brought = importFlowFile(sent);
    const sentOver = join(root, 'flows', 'sent-over.json');
    check('an imported flow is copied into flows, named after it', existsSync(sentOver) && getFlow(brought.id)?.name === 'Sent over');
    check('and the file it came from is left as it was', !('id' in (JSON.parse(readFileSync(sent, 'utf8')) as object)));
    check(
        'the skills it carries go into the library, never over one there',
        existsSync(join(root, 'skills', 'carried', 'SKILL.md')) &&
        readFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), 'utf8').includes('Saved elsewhere.'),
    );
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
    check('deleting flows leaves the skills', existsSync(join(root, 'skills', 'carried', 'SKILL.md')));
    rmSync(elsewhere, {recursive: true, force: true});

    // One workspace is open at a time, and each has its own flows, skills and runs.
    const away = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-away-'));
    openWorkspace(away);
    check(
        'another workspace lists only its own flows and skills',
        (JSON.parse(await call('list_flows')) as unknown[]).length === 0 &&
        (JSON.parse(await call('list_skills')) as unknown[]).length === 0,
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
