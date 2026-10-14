import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getHubsProjects, getFolderContents, getItemTip, getUserId, getFolderPath, getItemFolderPath, ensureFolderPath } from './aps.js';
import {
    DEFAULT_REVIT_VERSION, REVIT_VERSIONS, cancelMigration, getMigrationStatus, getMigratorStatus, submitMigration,
} from './automation.js';

const VIEWER_HTML = readFileSync(new URL('./viewer.html', import.meta.url), 'utf-8');
// The page's pure helpers live in their own module so they can be unit-tested; inline them as plain script.
const MIGRATION_LOGIC = readFileSync(new URL('./migration-logic.js', import.meta.url), 'utf-8').replace(/^export /gm, '');
const MIGRATION_HTML = readFileSync(new URL('./migration.html', import.meta.url), 'utf-8').replace('/*__MIGRATION_LOGIC__*/', () => MIGRATION_LOGIC);

const VIEWER_RESOURCE_URI = 'ui://aps-mcp/viewer.html';
const VIEWER_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const MIGRATION_RESOURCE_URI = 'ui://aps-mcp/migration.html';
const VIEWER_DOMAINS = [
    'https://developer.api.autodesk.com',
    'https://cdn.derivative.autodesk.com',
    'https://fonts.autodesk.com',
];
const VIEWER_SCRIPT_DOMAINS = ['https://cdn.jsdelivr.net'];

export function createMcpServer(authenticationProvider, publicUrl) {
    const server = new McpServer({
        name: 'aps-mcp-server',
        title: 'APS MCP Server',
        version: '1.0.0'
    });

    server.registerTool(
        'list-hubs-projects',
        {
            title: 'List hubs and projects',
            description: 'Lists all hubs and their projects available to the authenticated user.',
            annotations: { readOnlyHint: true }
        },
        async () => {
            const hubs = await getHubsProjects(authenticationProvider);
            return { content: [{ type: 'text', text: JSON.stringify(hubs, null, 2) }] };
        }
    );

    server.registerTool(
        'list-folder-contents',
        {
            title: 'List folder contents',
            description: 'Lists the contents of a folder in a project, or top-level folders if no folder ID is provided.',
            inputSchema: z.object({
                hubId: z.string().describe('Hub ID.'),
                projectId: z.string().describe('Project ID.'),
                folderId: z.string().optional().describe('Folder ID. Omit to list top-level folders.'),
            }),
            annotations: { readOnlyHint: true }
        },
        async ({ hubId, projectId, folderId }) => {
            const items = await getFolderContents(authenticationProvider, hubId, projectId, folderId);
            return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        }
    );

    server.registerTool(
        'create-folder',
        {
            title: 'Create folder',
            description: 'Creates a folder (or a nested path of folders) inside an existing folder of an ACC/BIM 360 project, reusing any segments that already exist. Only call this when the user explicitly asks to create a folder. Get the parent folder ID from list-folder-contents (top-level folders such as "Project Files" can be used as the parent).',
            inputSchema: z.object({
                projectId: z.string().describe('Project ID (must start with "b.").'),
                parentFolderId: z.string().describe('ID of the existing folder to create the new folder in.'),
                folderPath: z.string().describe('Folder name, or slash-separated nested path such as "AU 2026/Migrated". Existing segments are reused.'),
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
        },
        async ({ projectId, parentFolderId, folderPath }) => {
            const result = await ensureFolderPath(authenticationProvider, projectId, parentFolderId, folderPath);
            const text = result.created.length
                ? `Created ${result.created.map(n => `"${n}"`).join(', ')}. Folder: "${result.path}" (${result.folderId}).`
                : `Folder already existed, nothing created: "${result.path}" (${result.folderId}).`;
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, { type: 'text', text }] };
        }
    );

    server.registerTool(
        'check-migrator-setup',
        {
            title: 'Check RCW migrator setup',
            description: 'Reports, for each supported Revit version, whether the Design Automation engine and the RCW migrator activity are ready. Migrations only work for versions where activityReady is true; otherwise an administrator must run "npm run setup-da".',
            annotations: { readOnlyHint: true }
        },
        async () => {
            const status = await getMigratorStatus({ fresh: true });
            return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
        }
    );

    server.registerTool(
        'migrate-rcw-model',
        {
            title: 'Migrate RCW model',
            description: `Copies a Revit Cloud Worksharing (RCW) model into another ACC/BIM 360 project folder using Design Automation for Revit, upgrading it to the chosen Revit version. Only RCW models (extensionType "items:autodesk.bim360:C4RModel") are supported; linked models are not migrated. The migration runs asynchronously: this returns a workItemId, then use get-migration-status to follow it. A model cannot be downgraded, so pick a Revit version at least as new as the source. Defaults to Revit ${DEFAULT_REVIT_VERSION}. Get the IDs from list-hubs-projects and list-folder-contents.`,
            inputSchema: z.object({
                sourceProjectId: z.string().describe('Project ID of the source model (starts with "b.").'),
                sourceItemId: z.string().describe('Item ID of the source RCW model.'),
                targetHubId: z.string().describe('Hub ID of the target project (starts with "b.").'),
                targetProjectId: z.string().describe('Project ID of the target project.'),
                targetFolderId: z.string().describe('Folder ID (URN) in the target project to save the model into.'),
                targetName: z.string().optional().describe('Name for the migrated model. Defaults to the source file name.'),
                revitVersion: z.enum(Object.keys(REVIT_VERSIONS)).optional().describe(`Revit version to migrate to. Defaults to ${DEFAULT_REVIT_VERSION}.`),
            }),
            _meta: {
                ui: { resourceUri: MIGRATION_RESOURCE_URI },
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
        },
        async ({ sourceProjectId, sourceItemId, targetHubId, targetProjectId, targetFolderId, targetName, revitVersion }) => {
            console.log(`migrate-rcw-model: ${sourceProjectId}/${sourceItemId} -> ${targetProjectId}/${targetFolderId} as ${targetName ?? '(source name)'} (Revit ${revitVersion ?? 'default'})`);
            const [tip, sourceFolderPath, targetFolderPath, ownerKey, userToken] = await Promise.all([
                getItemTip(authenticationProvider, sourceProjectId, sourceItemId),
                getItemFolderPath(authenticationProvider, sourceProjectId, sourceItemId),
                getFolderPath(authenticationProvider, targetProjectId, targetFolderId).catch(() => {
                    throw new Error(`Target folder ${targetFolderId} was not found in project ${targetProjectId}. Check the IDs with list-folder-contents; several folders can share the same name.`);
                }),
                getUserId(authenticationProvider),
                authenticationProvider.getAccessToken(),
            ]);
            const job = await submitMigration({
                ownerKey,
                userToken,
                source: { ...tip, folderPath: sourceFolderPath },
                target: { hubId: targetHubId, projectId: targetProjectId, folderId: targetFolderId, folderPath: targetFolderPath, name: targetName },
                revitVersion,
            });
            return {
                structuredContent: { jobs: [job] },
                content: [{ type: 'text', text: JSON.stringify({ jobs: [job] }) }, { type: 'text', text: `Started migrating "${job.source.name}" from "${job.source.folderPath}" to "${job.target.folderPath} / ${job.fileName}" as Revit ${job.revitVersion} (workItemId ${job.workItemId}). Report this exact target location to the user. Use get-migration-status to follow progress.` }],
            };
        }
    );

    server.registerTool(
        'get-migration-status',
        {
            title: 'Get migration status',
            description: 'Returns the status of RCW migration jobs started by migrate-rcw-model. Statuses: pending, inprogress, success, cancelled, or a failed* value; failed jobs include the tail of the Revit report log explaining why.',
            inputSchema: z.object({
                workItemIds: z.array(z.string()).min(1).describe('workItemIds returned by migrate-rcw-model.'),
            }),
            _meta: { ui: { visibility: ['model', 'app'] } },
            annotations: { readOnlyHint: true }
        },
        async ({ workItemIds }) => {
            const jobs = await getMigrationStatus(workItemIds, await getUserId(authenticationProvider));
            return { structuredContent: { jobs }, content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }] };
        }
    );

    server.registerTool(
        'cancel-migration',
        {
            title: 'Cancel migration',
            description: 'Cancels a pending RCW migration job. A job that has already started may still complete.',
            inputSchema: z.object({
                workItemId: z.string().describe('workItemId returned by migrate-rcw-model.'),
            }),
            _meta: { ui: { visibility: ['model', 'app'] } },
            annotations: { readOnlyHint: false, destructiveHint: true }
        },
        async ({ workItemId }) => {
            const job = await cancelMigration(workItemId, await getUserId(authenticationProvider));
            return { structuredContent: { jobs: [job] }, content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] };
        }
    );

    server.registerTool(
        'preview-design',
        {
            title: 'Preview design',
            description: 'Displays an interactive 3D preview of a design in APS Viewer. Use this when the user wants to visualise, inspect, or explore a design file.',
            inputSchema: z.object({
                projectId: z.string().describe('Project ID the design belongs to.'),
                designId: z.string().describe('Item ID of the design to preview.'),
                region: z.string().optional().describe('Hub region (e.g. "US", "EMEA"). Defaults to "US".'),
            }),
            _meta: {
                ui: { resourceUri: VIEWER_RESOURCE_URI },
            },
            annotations: { readOnlyHint: true }
        },
        async ({ projectId, designId, region = 'US' }) => {
            const accessToken = await authenticationProvider.getAccessToken();
            const tip = await getItemTip(authenticationProvider, projectId, designId);
            const config = {
                accessToken,
                env: 'AutodeskProduction2',
                api: region === 'US' ? 'streamingV2' : `streamingV2_${region}`,
            };
            return {
                structuredContent: { name: tip.name, urn: tip.derivativeUrn, config },
                content: [{ type: 'text', text: `Here is the preview of ${tip.name}.` }],
            };
        }
    );

    server.registerResource(
        'viewer',
        VIEWER_RESOURCE_URI,
        { mimeType: VIEWER_RESOURCE_MIME_TYPE },
        async (uri) => ({
            contents: [{
                uri: uri.toString(),
                mimeType: VIEWER_RESOURCE_MIME_TYPE,
                text: VIEWER_HTML,
                _meta: {
                    ui: {
                        domain: publicUrl,
                        csp: {
                            resourceDomains: [...VIEWER_DOMAINS, ...VIEWER_SCRIPT_DOMAINS, 'blob:', 'data:'],
                            connectDomains: [...VIEWER_DOMAINS, 'wss://cdn.derivative.autodesk.com'],
                        },
                    },
                },
            }]
        })
    );

    server.registerResource(
        'migration',
        MIGRATION_RESOURCE_URI,
        { mimeType: VIEWER_RESOURCE_MIME_TYPE },
        async (uri) => ({
            contents: [{
                uri: uri.toString(),
                mimeType: VIEWER_RESOURCE_MIME_TYPE,
                text: MIGRATION_HTML,
                _meta: {
                    ui: {
                        domain: publicUrl,
                        // The page only talks to this server through the host, so it needs no connect domains.
                        csp: { resourceDomains: VIEWER_SCRIPT_DOMAINS, connectDomains: [] },
                    },
                },
            }]
        })
    );

    return server;
}
