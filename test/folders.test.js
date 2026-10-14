import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureFolderPath } from '../aps.js';

// In-memory stand-in for DataManagementClient: a tree of folders keyed by ID.
function fakeClient({ conflictOnce = false } = {}) {
    const folders = new Map([['root', { id: 'root', attributes: { displayName: 'Project Files' }, parent: null }]]);
    let n = 0, conflict = conflictOnce;
    const add = (parent, name) => {
        const id = `f${++n}`;
        folders.set(id, { id, attributes: { displayName: name }, parent });
        return folders.get(id);
    };
    const client = {
        created: [],
        add,
        async getFolderContents(_p, folderId, { pageNumber = 0, pageLimit = 200 } = {}) {
            const all = [...folders.values()].filter(f => f.parent === folderId);
            return { data: all.slice(pageNumber * pageLimit, (pageNumber + 1) * pageLimit) };
        },
        async createFolder(_p, payload) {
            const { name } = payload.data.attributes;
            const parent = payload.data.relationships.parent.data.id;
            assert.equal(payload.data.attributes.extension.type, 'folders:autodesk.bim360:Folder');
            if (conflict) { // someone else creates it between our lookup and our create
                conflict = false;
                add(parent, name);
                throw Object.assign(new Error('conflict'), { axiosError: { response: { status: 409 } } });
            }
            client.created.push(name);
            return { data: add(parent, name) };
        },
        async getFolder(_p, id) { return { data: folders.get(id) }; },
        async getFolderParent(_p, id) {
            const parent = folders.get(id).parent;
            if (!parent) throw new Error('no parent');
            return { data: folders.get(parent) };
        },
    };
    return client;
}

const run = (client, path, project = 'b.1') => ensureFolderPath(null, project, 'root', path, client);

test('creates every missing segment of a nested path', async () => {
    const client = fakeClient();
    const r = await run(client, 'AU 2026/Migrated');
    assert.deepEqual(r.created, ['AU 2026', 'Migrated']);
    assert.equal(r.path, 'Project Files / AU 2026 / Migrated');
});

test('reuses existing folders, ignoring case, and only creates the rest', async () => {
    const client = fakeClient();
    client.add('root', 'AU 2026');
    const r = await run(client, 'au 2026/New');
    assert.deepEqual(r.created, ['New']);
    assert.equal(r.path, 'Project Files / AU 2026 / New');
});

test('is idempotent: second call creates nothing and returns the same folder', async () => {
    const client = fakeClient();
    const a = await run(client, 'A/B');
    const b = await run(client, 'A/B');
    assert.deepEqual(b.created, []);
    assert.equal(b.folderId, a.folderId);
});

test('recovers from a 409 by reusing the folder created concurrently', async () => {
    const client = fakeClient({ conflictOnce: true });
    const r = await run(client, 'Raced');
    assert.deepEqual(r.created, []);
    assert.equal(r.path, 'Project Files / Raced');
});

test('finds a match on a later page instead of creating a duplicate', async () => {
    const client = fakeClient();
    for (let i = 0; i < 205; i++) client.add('root', `Folder ${i}`);
    const r = await run(client, 'Folder 204');
    assert.deepEqual(r.created, []);
    assert.deepEqual(client.created, []);
});

test('rethrows non-409 errors', async () => {
    const client = fakeClient();
    client.createFolder = async () => { throw Object.assign(new Error('forbidden'), { axiosError: { response: { status: 403 } } }); };
    await assert.rejects(run(client, 'X'), /forbidden/);
});

test('rejects personal-hub projects and empty paths', async () => {
    const client = fakeClient();
    await assert.rejects(run(client, 'X', 'a.personal'), /ACC\/BIM 360/);
    await assert.rejects(run(client, ' / '), /at least one/);
});

test('ignores slashes padding and blank segments', async () => {
    const client = fakeClient();
    const r = await run(client, '/A//B/');
    assert.deepEqual(r.created, ['A', 'B']);
});
