import { AuthenticationClient, Scopes } from '@aps_sdk/authentication';
import { RCW_VERSION_TYPE } from './aps.js';

export const REVIT_VERSIONS = {
    '2025': { engine: 'Autodesk.Revit+2025', bundleZip: 'RCWMigratorApp-2025.zip' },
    '2026': { engine: 'Autodesk.Revit+2026', bundleZip: 'RCWMigratorApp-2026.zip' },
    '2027': { engine: 'Autodesk.Revit+2027', bundleZip: 'RCWMigratorApp-2027.zip' },
};
export const DEFAULT_REVIT_VERSION = '2027';

const authClient = new AuthenticationClient();
let cachedToken = { token: null, expiresAt: 0 };

export function getDaConfig(env = process.env) {
    const region = env.APS_DA_REGION || 'us-east';
    return {
        nickname: env.APS_DA_NICKNAME || env.APS_CLIENT_ID,
        alias: env.APS_DA_ALIAS || 'dev',
        baseUrl: `https://developer.api.autodesk.com/da/${region}/v3`,
    };
}

export const bundleName = (version) => `RCWMigrator${version}AppBundle`;
export const activityName = (version) => `RCWMigrator${version}Activity`;
export const qualifiedId = (name, { nickname, alias }) => `${nickname}.${name}+${alias}`;

// 2-legged token for Design Automation; server-side only, never returned to clients.
export async function getAppToken() {
    if (cachedToken.token && cachedToken.expiresAt > Date.now() + 60 * 1000) return cachedToken.token;
    const { access_token, expires_in } = await authClient.getTwoLeggedToken(
        process.env.APS_CLIENT_ID, process.env.APS_CLIENT_SECRET, [Scopes.CodeAll]);
    cachedToken = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
    return cachedToken.token;
}

export function setAppTokenForTesting(token) {
    cachedToken = { token, expiresAt: Date.now() + 3600 * 1000 };
}

export async function daFetch(path, { method = 'GET', body, query } = {}) {
    const { baseUrl } = getDaConfig();
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, v);
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${await getAppToken()}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
        throw new Error(`Design Automation ${method} ${path} failed (${res.status}): ${text}`);
    }
    return data;
}

// Follows paginationToken and returns every entry.
export async function daList(path) {
    const all = [];
    let page = null;
    do {
        const { data = [], paginationToken = null } = await daFetch(path, { query: { page } });
        all.push(...data);
        page = paginationToken;
    } while (page);
    return all;
}

export async function listRevitEngines() {
    return (await daList('/engines')).filter((e) => e.includes('Revit')).sort();
}

export function activityDefinition(version, config = getDaConfig()) {
    const bundle = bundleName(version);
    return {
        id: activityName(version),
        engine: REVIT_VERSIONS[version].engine,
        appbundles: [qualifiedId(bundle, config)],
        commandLine: [`$(engine.path)\\\\revitcoreconsole.exe /i "$(args[rvtFile].path)" /al "$(appbundles[${bundle}].path)"`],
        parameters: {
            rvtFile: { verb: 'get', description: 'Input Revit cloud model', required: false },
            inputParams: { verb: 'get', description: 'Target location JSON', localName: 'params.json', required: false },
        },
        description: `Migrate Revit Cloud Worksharing model (Revit ${version})`,
    };
}

// multipart upload to the pre-signed S3 form; the `file` field must come last.
export async function uploadBundle(uploadParameters, zipBytes) {
    const form = new FormData();
    for (const [k, v] of Object.entries(uploadParameters.formData)) form.append(k, v);
    form.append('file', new Blob([zipBytes]), 'bundle.zip');
    const res = await fetch(uploadParameters.endpointURL, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Bundle upload failed (${res.status}): ${await res.text()}`);
}

// Creates the resource, or a new version if it already exists, and points the alias at the result.
async function upsertWithAlias(kind, id, qualified, existing, spec, config) {
    if (existing.includes(qualified)) {
        const created = await daFetch(`/${kind}/${id}/versions`, { method: 'POST', body: spec.version });
        await daFetch(`/${kind}/${id}/aliases/${config.alias}`, { method: 'PATCH', body: { version: created.version } });
        return { created, action: 'updated' };
    }
    const created = await daFetch(`/${kind}`, { method: 'POST', body: spec.create });
    await daFetch(`/${kind}/${id}/aliases`, { method: 'POST', body: { id: config.alias, version: 1 } });
    return { created, action: 'created' };
}

export async function setupVersion(version, { readBundle, config = getDaConfig() } = {}) {
    const { engine } = REVIT_VERSIONS[version];
    const bundle = bundleName(version);
    const bundleId = qualifiedId(bundle, config);

    const bundles = await daList('/appbundles');
    const bundleRes = await upsertWithAlias('appbundles', bundle, bundleId, bundles, {
        create: { id: bundle, engine, description: `Migrate Revit Cloud Model (Revit ${version})` },
        version: { engine, description: `Migrate Revit Cloud Model (Revit ${version})` },
    }, config);
    await uploadBundle(bundleRes.created.uploadParameters, await readBundle(REVIT_VERSIONS[version].bundleZip));

    const activities = await daList('/activities');
    const def = activityDefinition(version, config);
    const { id, ...versionSpec } = def;
    const activityRes = await upsertWithAlias('activities', id, qualifiedId(id, config), activities, {
        create: def,
        version: versionSpec,
    }, config);

    return { version, appBundle: bundleId, bundleAction: bundleRes.action, activity: qualifiedId(id, config), activityAction: activityRes.action };
}

let statusCache = { at: 0, value: null };
const STATUS_TTL_MS = 5 * 60 * 1000;

// Per-version readiness: is the engine offered by DA, and is our activity (with alias) deployed.
export async function getMigratorStatus({ fresh = false, config = getDaConfig() } = {}) {
    if (!fresh && statusCache.value && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
    const [engines, activities] = await Promise.all([listRevitEngines(), daList('/activities')]);
    const value = Object.entries(REVIT_VERSIONS).map(([revitVersion, { engine }]) => ({
        revitVersion,
        engineAvailable: engines.includes(engine),
        activityReady: activities.includes(qualifiedId(activityName(revitVersion), config)),
    }));
    statusCache = { at: Date.now(), value };
    return value;
}

export function resetMigratorStatusCache() {
    statusCache = { at: 0, value: null };
}

// ---- Migration jobs -------------------------------------------------------------------------

const ACTIVE_STATUSES = new Set(['pending', 'inprogress']);
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
const REPORT_TAIL_LINES = 40;

export const isTerminalStatus = (status) => !ACTIVE_STATUSES.has(status);

const jobs = new Map();

function pruneJobs() {
    for (const [id, job] of jobs) {
        if (job.finishedAt && Date.now() - Date.parse(job.finishedAt) > JOB_RETENTION_MS) jobs.delete(id);
    }
}

export function clearJobsForTesting() {
    jobs.clear();
}

const publicJob = ({ ownerKey, ...job }) => job;

// Only the user who submitted a job may see or cancel it; unknown ids (e.g. after a restart) are refused too.
function getOwnedJob(workItemId, ownerKey) {
    const job = jobs.get(workItemId);
    if (!job || job.ownerKey !== ownerKey) {
        throw new Error(`Migration job ${workItemId} was not found. It may belong to another user, or the server was restarted.`);
    }
    return job;
}

// The Revit plugin reads the target as a data: URL in the legacy single-quote JSON form, so quotes in names can't be carried.
function buildInputParams({ hubId, projectId, folderId, modelName }) {
    if (/['"]/.test(modelName) || /['"]/.test(folderId)) {
        throw new Error('Quotes in the model name or folder id are not supported by the migrator.');
    }
    const params = {
        TargetAccountGuid: hubId.replace(/^b\./, ''),
        TargetProjectGuid: projectId.replace(/^b\./, ''),
        TargetFolderUrn: folderId,
        TargetModelName: modelName,
    };
    return 'data:application/json, ' + JSON.stringify(params).replace(/"/g, "'");
}

export async function submitMigration({ ownerKey, userToken, source, target, revitVersion = DEFAULT_REVIT_VERSION, config = getDaConfig() }) {
    if (!REVIT_VERSIONS[revitVersion]) {
        throw new Error(`Unsupported Revit version ${revitVersion}. Supported: ${Object.keys(REVIT_VERSIONS).join(', ')}.`);
    }
    if (source.versionType !== RCW_VERSION_TYPE) {
        throw new Error(`"${source.name}" is not a Revit Cloud Worksharing model; only RCW (C4RModel) models can be migrated.`);
    }
    if (!source.storageId) throw new Error(`"${source.name}" has no storage to read from.`);

    const status = (await getMigratorStatus({ config })).find((s) => s.revitVersion === revitVersion);
    if (!status?.activityReady) {
        throw new Error(`The Revit ${revitVersion} migrator is not set up. An administrator must run "npm run setup-da -- --versions ${revitVersion}".`);
    }

    const modelName = target.name ?? source.name;
    const body = {
        activityId: qualifiedId(activityName(revitVersion), config),
        arguments: {
            rvtFile: { url: source.storageId, headers: { Authorization: `Bearer ${userToken}` } },
            inputParams: { url: buildInputParams({ ...target, modelName }) },
            adsk3LeggedToken: userToken,
        },
    };
    const workItem = await daFetch('/workitems', { method: 'POST', body });

    pruneJobs();
    const job = {
        workItemId: workItem.id,
        ownerKey,
        fileName: modelName,
        revitVersion,
        source: { name: source.name, folderPath: source.folderPath },
        target: { projectId: target.projectId, folderId: target.folderId, folderPath: target.folderPath },
        status: workItem.status ?? 'pending',
        submittedAt: new Date().toISOString(),
        finishedAt: null,
    };
    jobs.set(job.workItemId, job);
    return publicJob(job);
}

async function fetchReportTail(reportUrl) {
    try {
        const res = await fetch(reportUrl);
        if (!res.ok) return null;
        return (await res.text()).trimEnd().split('\n').slice(-REPORT_TAIL_LINES).join('\n');
    } catch {
        return null;
    }
}

export async function getMigrationStatus(workItemIds, ownerKey) {
    return Promise.all(workItemIds.map(async (id) => {
        const job = getOwnedJob(id, ownerKey);
        if (!isTerminalStatus(job.status)) {
            const wi = await daFetch(`/workitems/${id}`);
            job.status = wi.status;
            if (isTerminalStatus(job.status)) {
                job.finishedAt = new Date().toISOString();
                job.reportTail = job.status === 'success' ? null : await fetchReportTail(wi.reportUrl);
            }
        }
        return publicJob(job);
    }));
}

export async function cancelMigration(workItemId, ownerKey) {
    const job = getOwnedJob(workItemId, ownerKey);
    if (isTerminalStatus(job.status)) return { ...publicJob(job), note: `Job already finished (${job.status}).` };
    await daFetch(`/workitems/${workItemId}`, { method: 'DELETE' });
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    return { ...publicJob(job), note: 'Cancel requested. A job that already started may still complete.' };
}
