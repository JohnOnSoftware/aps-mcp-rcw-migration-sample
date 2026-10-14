import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer } from '../mcp.js';

test('server registers the original and the migration tools', () => {
    const server = createMcpServer({ getAccessToken: async () => 'x' }, 'http://localhost:3000');
    const names = Object.keys(server._registeredTools).sort();
    assert.deepEqual(names, [
        'cancel-migration', 'check-migrator-setup', 'create-folder', 'get-migration-status', 'list-folder-contents',
        'list-hubs-projects', 'migrate-rcw-model', 'preview-design',
    ]);
});

test('migrate-rcw-model only accepts supported Revit versions', () => {
    const server = createMcpServer({ getAccessToken: async () => 'x' }, 'http://localhost:3000');
    const schema = server._registeredTools['migrate-rcw-model'].inputSchema;
    const base = { sourceProjectId: 'b.1', sourceItemId: 'i', targetHubId: 'b.h', targetProjectId: 'b.2', targetFolderId: 'f' };
    assert.ok(schema.safeParse({ ...base, revitVersion: '2027' }).success);
    assert.ok(schema.safeParse(base).success);
    assert.ok(!schema.safeParse({ ...base, revitVersion: '2019' }).success);
});

test('create-folder requires a parent folder and a path', () => {
    const server = createMcpServer({ getAccessToken: async () => 'x' }, 'http://localhost:3000');
    const schema = server._registeredTools['create-folder'].inputSchema;
    assert.ok(schema.safeParse({ projectId: 'b.1', parentFolderId: 'f', folderPath: 'A/B' }).success);
    assert.ok(!schema.safeParse({ projectId: 'b.1', folderPath: 'A' }).success);
});
