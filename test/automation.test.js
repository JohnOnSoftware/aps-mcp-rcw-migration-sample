import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { activityDefinition, daList, setAppTokenForTesting, setupVersion } from '../automation.js';

const config = { nickname: 'nick', alias: 'dev', baseUrl: 'https://developer.api.autodesk.com/da/us-east/v3' };
const realFetch = globalThis.fetch;
let calls;

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// routes: "METHOD /path" -> response body (or function). Path excludes the base URL and query.
function mockFetch(routes) {
    globalThis.fetch = async (url, init = {}) => {
        const u = new URL(url);
        const method = init.method ?? 'GET';
        const key = u.hostname === 'developer.api.autodesk.com' ? `${method} ${u.pathname.replace('/da/us-east/v3', '')}` : `${method} ${u.href}`;
        calls.push({ key, init, query: u.searchParams });
        const route = routes[key];
        if (route === undefined) return json({ error: `unmocked ${key}` }, 500);
        return typeof route === 'function' ? route(init, u) : json(route);
    };
}

beforeEach(() => {
    calls = [];
    setAppTokenForTesting('app-token');
});
afterEach(() => { globalThis.fetch = realFetch; });

const upload = { endpointURL: 'https://s3.example.com/upload', formData: { key: 'k1', policy: 'p1' } };

test('daList follows paginationToken', async () => {
    mockFetch({
        'GET /engines': (_i, u) => u.searchParams.get('page') === 'p2'
            ? json({ data: ['Autodesk.Revit+2026'] })
            : json({ data: ['Autodesk.Revit+2025'], paginationToken: 'p2' }),
    });
    assert.deepEqual(await daList('/engines'), ['Autodesk.Revit+2025', 'Autodesk.Revit+2026']);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer app-token');
});

test('activityDefinition targets the right engine, bundle and command line', () => {
    const def = activityDefinition('2027', config);
    assert.equal(def.id, 'RCWMigrator2027Activity');
    assert.equal(def.engine, 'Autodesk.Revit+2027');
    assert.deepEqual(def.appbundles, ['nick.RCWMigrator2027AppBundle+dev']);
    assert.match(def.commandLine[0], /appbundles\[RCWMigrator2027AppBundle\]\.path/);
    assert.equal(def.parameters.inputParams.localName, 'params.json');
});

test('setupVersion creates bundle, alias, upload and activity when nothing exists', async () => {
    mockFetch({
        'GET /appbundles': { data: [] },
        'POST /appbundles': { version: 1, uploadParameters: upload },
        'POST /appbundles/RCWMigrator2026AppBundle/aliases': {},
        [`POST ${upload.endpointURL}`]: new Response(null, { status: 204 }),
        'GET /activities': { data: [] },
        'POST /activities': { version: 1 },
        'POST /activities/RCWMigrator2026Activity/aliases': {},
    });
    let uploaded;
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (String(url) === upload.endpointURL) { uploaded = init.body; return new Response(null, { status: 204 }); }
        return orig(url, init);
    };
    const r = await setupVersion('2026', { config, readBundle: async () => Buffer.from('zip') });
    assert.deepEqual([r.bundleAction, r.activityAction], ['created', 'created']);
    const aliasCall = calls.find((c) => c.key.endsWith('/aliases') && c.key.includes('appbundles'));
    assert.deepEqual(JSON.parse(aliasCall.init.body), { id: 'dev', version: 1 });
    assert.deepEqual([...uploaded.keys()], ['key', 'policy', 'file'], 'file field must be last');
});

test('setupVersion creates a new version and moves the alias when resources exist', async () => {
    mockFetch({
        'GET /appbundles': { data: ['nick.RCWMigrator2026AppBundle+dev'] },
        'POST /appbundles/RCWMigrator2026AppBundle/versions': { version: 3, uploadParameters: upload },
        'PATCH /appbundles/RCWMigrator2026AppBundle/aliases/dev': {},
        'GET /activities': { data: ['nick.RCWMigrator2026Activity+dev'] },
        'POST /activities/RCWMigrator2026Activity/versions': { version: 2 },
        'PATCH /activities/RCWMigrator2026Activity/aliases/dev': {},
    });
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url) === upload.endpointURL ? new Response(null, { status: 204 }) : orig(url, init);
    const r = await setupVersion('2026', { config, readBundle: async () => Buffer.from('zip') });
    assert.deepEqual([r.bundleAction, r.activityAction], ['updated', 'updated']);
    const patches = calls.filter((c) => c.key.startsWith('PATCH'));
    assert.deepEqual(patches.map((p) => JSON.parse(p.init.body).version), [3, 2]);
    assert.ok(!calls.some((c) => c.key === 'POST /appbundles'), 'must not recreate the bundle');
});

test('DA errors surface status and body', async () => {
    mockFetch({ 'GET /engines': () => json({ reason: 'nope' }, 403) });
    await assert.rejects(() => daList('/engines'), /403.*nope/);
});

test('getMigratorStatus reports engine and activity readiness per version, with caching', async () => {
    const { getMigratorStatus, resetMigratorStatusCache } = await import('../automation.js');
    resetMigratorStatusCache();
    mockFetch({
        'GET /engines': { data: ['Autodesk.Revit+2026', 'Autodesk.Revit+2027', 'Autodesk.AutoCAD+25'] },
        'GET /activities': { data: ['nick.RCWMigrator2026Activity+dev', 'nick.RCWMigrator2027Activity+other'] },
    });
    const status = await getMigratorStatus({ config });
    assert.deepEqual(status, [
        { revitVersion: '2025', engineAvailable: false, activityReady: false },
        { revitVersion: '2026', engineAvailable: true, activityReady: true },
        { revitVersion: '2027', engineAvailable: true, activityReady: false },
    ]);
    const before = calls.length;
    await getMigratorStatus({ config });
    assert.equal(calls.length, before, 'second call is served from cache');
    await getMigratorStatus({ config, fresh: true });
    assert.ok(calls.length > before, 'fresh bypasses cache');
});
