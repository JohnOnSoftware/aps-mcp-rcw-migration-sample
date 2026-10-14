import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatElapsed, isTerminal, mergeJobs, nextDelay, statusInfo, summarize } from '../migration-logic.js';
import { createMcpServer } from '../mcp.js';

const job = (over) => ({ workItemId: 'a', fileName: 'A.rvt', status: 'pending', submittedAt: '2026-10-14T10:00:00Z', finishedAt: null, ...over });

test('statusInfo labels every DA status', () => {
    assert.deepEqual(statusInfo('pending'), { label: 'Queued', kind: 'active' });
    assert.deepEqual(statusInfo('inprogress'), { label: 'In progress', kind: 'active' });
    assert.equal(statusInfo('success').kind, 'success');
    assert.equal(statusInfo('cancelled').kind, 'cancelled');
    assert.deepEqual(statusInfo('failedInstructions'), { label: 'Failed (failedInstructions)', kind: 'failed' });
    assert.equal(isTerminal('pending'), false);
    assert.equal(isTerminal('failedUpload'), true);
});

test('nextDelay backs off exponentially and caps at 60s', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 10].map((n) => nextDelay(n)), [5000, 10000, 20000, 40000, 60000, 60000]);
});

test('formatElapsed counts to now while running and to finishedAt once done', () => {
    const start = '2026-10-14T10:00:00Z';
    assert.equal(formatElapsed(start, null, Date.parse('2026-10-14T11:02:03Z')), '01:02:03');
    assert.equal(formatElapsed(start, '2026-10-14T10:03:12Z', Date.parse('2026-10-15T00:00:00Z')), '00:03:12');
    assert.equal(formatElapsed(start, null, Date.parse('2026-10-14T09:00:00Z')), '00:00:00', 'clock skew never goes negative');
});

test('mergeJobs updates in place, keeps order and appends new jobs', () => {
    const merged = mergeJobs([job({ workItemId: 'a' }), job({ workItemId: 'b' })], [job({ workItemId: 'b', status: 'success' }), job({ workItemId: 'c' })]);
    assert.deepEqual(merged.map((j) => [j.workItemId, j.status]), [['a', 'pending'], ['b', 'success'], ['c', 'pending']]);
});

test('summarize reports successes, cancellations and failures', () => {
    const text = summarize([job({ status: 'success' }), job({ workItemId: 'b', fileName: 'Site.rvt', status: 'failedInstructions' }), job({ workItemId: 'c', status: 'cancelled' })]);
    assert.equal(text, '1 of 3 migration(s) succeeded; 1 cancelled; Site.rvt failed: failedInstructions.');
});

function registered() {
    return createMcpServer({ getAccessToken: async () => 'x' }, 'http://localhost:3000');
}

test('migrate-rcw-model is bound to the migration page; status and cancel are callable by the page', () => {
    const tools = registered()._registeredTools;
    assert.equal(tools['migrate-rcw-model']._meta.ui.resourceUri, 'ui://aps-mcp/migration.html');
    for (const name of ['get-migration-status', 'cancel-migration']) {
        assert.deepEqual(tools[name]._meta.ui.visibility, ['model', 'app']);
    }
});

test('migration page resource inlines the logic as valid module code, with a locked-down CSP', async () => {
    const entry = Object.entries(registered()._registeredResources).find(([uri]) => uri === 'ui://aps-mcp/migration.html');
    assert.ok(entry, 'migration resource registered');
    const { contents: [content] } = await entry[1].readCallback(new URL('ui://aps-mcp/migration.html'));
    assert.equal(content.mimeType, 'text/html;profile=mcp-app');
    assert.ok(!content.text.includes('__MIGRATION_LOGIC__'), 'placeholder replaced');
    assert.ok(content.text.includes('function statusInfo'), 'logic inlined');
    assert.ok(!/^export /m.test(content.text), 'no leftover export keywords');
    assert.deepEqual(content._meta.ui.csp.connectDomains, []);

    const script = content.text.match(/<script type="module">([\s\S]*)<\/script>/)[1];
    const file = join(mkdtempSync(join(tmpdir(), 'mig-')), 'page.mjs');
    writeFileSync(file, script);
    execFileSync(process.execPath, ['--check', file]); // throws on a syntax error
});
