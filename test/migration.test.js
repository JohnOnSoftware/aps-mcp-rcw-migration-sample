import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    cancelMigration, clearJobsForTesting, getMigrationStatus, isTerminalStatus,
    resetMigratorStatusCache, setAppTokenForTesting, submitMigration,
} from '../automation.js';
import { toFolderEntry } from '../aps.js';

const config = { nickname: 'nick', alias: 'dev', baseUrl: 'https://developer.api.autodesk.com/da/us-east/v3' };
const realFetch = globalThis.fetch;
let calls, workitemStatus;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    calls = [];
    workitemStatus = { id: 'wi-1', status: 'pending', reportUrl: 'https://report.example.com/r.txt' };
    clearJobsForTesting();
    resetMigratorStatusCache();
    setAppTokenForTesting('app-token');
    globalThis.fetch = async (url, init = {}) => {
        const u = new URL(url);
        const method = init.method ?? 'GET';
        const path = u.pathname.replace('/da/us-east/v3', '');
        calls.push({ method, path, init });
        if (u.hostname === 'report.example.com') return new Response(Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'));
        if (path === '/engines') return json({ data: ['Autodesk.Revit+2026', 'Autodesk.Revit+2027'] });
        if (path === '/activities') return json({ data: ['nick.RCWMigrator2026Activity+dev'] });
        if (method === 'POST' && path === '/workitems') return json({ id: 'wi-1', status: 'pending' });
        if (method === 'GET' && path === '/workitems/wi-1') return json(workitemStatus);
        if (method === 'DELETE' && path === '/workitems/wi-1') return new Response(null, { status: 204 });
        return json({ error: `unmocked ${method} ${path}` }, 500);
    };
});
afterEach(() => { globalThis.fetch = realFetch; });

const source = { name: 'Tower.rvt', storageId: 'urn:adsk.wipprod:fs.file:vf.abc?version=3', versionType: 'versions:autodesk.bim360:C4RModel' };
const target = { hubId: 'b.hub-guid', projectId: 'b.proj-guid', folderId: 'urn:adsk.wipprod:fs.folder:co.xyz' };
const submit = (over = {}) => submitMigration({ ownerKey: 'alice', userToken: 'user-token', source, target, revitVersion: '2026', config, ...over });

test('submitMigration builds the workitem like the original migrator', async () => {
    const job = await submit();
    const body = JSON.parse(calls.find((c) => c.path === '/workitems').init.body);
    assert.equal(body.activityId, 'nick.RCWMigrator2026Activity+dev');
    assert.equal(body.arguments.rvtFile.url, source.storageId);
    assert.equal(body.arguments.rvtFile.headers.Authorization, 'Bearer user-token');
    assert.equal(body.arguments.adsk3LeggedToken, 'user-token');
    assert.equal(body.arguments.inputParams.url,
        "data:application/json, {'TargetAccountGuid':'hub-guid','TargetProjectGuid':'proj-guid','TargetFolderUrn':'urn:adsk.wipprod:fs.folder:co.xyz','TargetModelName':'Tower.rvt'}");
    assert.deepEqual([job.workItemId, job.status, job.revitVersion, job.fileName], ['wi-1', 'pending', '2026', 'Tower.rvt']);
    assert.ok(!('ownerKey' in job), 'owner key never leaves the server');
});

test('targetName overrides the source file name', async () => {
    const job = await submit({ target: { ...target, name: 'Tower-v2.rvt' } });
    assert.equal(job.fileName, 'Tower-v2.rvt');
});

test('non-RCW files are rejected before any workitem is created', async () => {
    await assert.rejects(() => submit({ source: { ...source, versionType: 'versions:autodesk.bim360:File' } }), /not a Revit Cloud Worksharing/);
    assert.ok(!calls.some((c) => c.path === '/workitems'));
});

test('a Revit version without a configured activity is rejected with setup guidance', async () => {
    await assert.rejects(() => submit({ revitVersion: '2027' }), /npm run setup-da -- --versions 2027/);
    assert.ok(!calls.some((c) => c.path === '/workitems'));
});

test('unsupported version and quote characters are rejected', async () => {
    await assert.rejects(() => submit({ revitVersion: '2019' }), /Unsupported Revit version/);
    await assert.rejects(() => submit({ target: { ...target, name: "it's.rvt" } }), /Quotes/);
});

test('status polling records completion and returns the report tail on failure', async () => {
    await submit();
    workitemStatus = { ...workitemStatus, status: 'inprogress' };
    let [job] = await getMigrationStatus(['wi-1'], 'alice');
    assert.equal(job.status, 'inprogress');
    assert.equal(job.finishedAt, null);

    workitemStatus = { ...workitemStatus, status: 'failedInstructions' };
    [job] = await getMigrationStatus(['wi-1'], 'alice');
    assert.equal(job.status, 'failedInstructions');
    assert.ok(job.finishedAt);
    assert.equal(job.reportTail.split('\n').length, 40);
    assert.ok(job.reportTail.endsWith('line 100'));

    const before = calls.length;
    await getMigrationStatus(['wi-1'], 'alice');
    assert.equal(calls.length, before, 'terminal jobs are not polled again');
});

test('successful jobs carry no report tail', async () => {
    await submit();
    workitemStatus = { ...workitemStatus, status: 'success' };
    const [job] = await getMigrationStatus(['wi-1'], 'alice');
    assert.equal(job.reportTail, null);
});

test('other users cannot read or cancel a job; unknown ids are refused', async () => {
    await submit();
    await assert.rejects(() => getMigrationStatus(['wi-1'], 'bob'), /not found/);
    await assert.rejects(() => cancelMigration('wi-1', 'bob'), /not found/);
    await assert.rejects(() => getMigrationStatus(['nope'], 'alice'), /not found/);
    assert.ok(!calls.some((c) => c.method === 'DELETE'));
});

test('cancel deletes the workitem once and marks the job cancelled', async () => {
    await submit();
    const r = await cancelMigration('wi-1', 'alice');
    assert.equal(r.status, 'cancelled');
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
    const again = await cancelMigration('wi-1', 'alice');
    assert.match(again.note, /already finished/);
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
});

test('terminal status classification', () => {
    for (const s of ['pending', 'inprogress']) assert.equal(isTerminalStatus(s), false);
    for (const s of ['success', 'cancelled', 'failedDownload', 'failedInstructions', 'failedLimitProcessingTime']) assert.equal(isTerminalStatus(s), true);
});

test('toFolderEntry exposes extensionType so RCW models can be recognised', () => {
    const entry = toFolderEntry({ type: 'items', id: 'i1', attributes: { displayName: 'A.rvt', extension: { type: 'items:autodesk.bim360:C4RModel' }, lastModifiedTime: 't', lastModifiedUserName: 'u' } });
    assert.equal(entry.extensionType, 'items:autodesk.bim360:C4RModel');
    assert.equal(toFolderEntry({ type: 'folders', id: 'f', attributes: { displayName: 'F' } }).extensionType, undefined);
});

test('job reports source and target folder paths so the destination can be verified', async () => {
    const job = await submit({
        source: { ...source, folderPath: 'Project Files / AU Demo Sample' },
        target: { ...target, folderPath: 'Project Files / AU 2026 Demo' },
    });
    assert.equal(job.source.folderPath, 'Project Files / AU Demo Sample');
    assert.equal(job.target.folderPath, 'Project Files / AU 2026 Demo');
    assert.equal(job.source.name, 'Tower.rvt');
});
