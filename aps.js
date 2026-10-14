import { AuthenticationClient, Scopes, ResponseType } from '@aps_sdk/authentication';
import { DataManagementClient } from '@aps_sdk/data-management';

// Write scopes are needed so Revit (Design Automation) can save migrated models to the target project.
const SCOPES = [Scopes.DataRead, Scopes.DataWrite, Scopes.DataCreate, Scopes.AccountRead, Scopes.AccountWrite, Scopes.UserProfileRead];

export class UserAuthenticationProvider {
    constructor(clientId, clientSecret, callbackUrl) {
        this.authClient = new AuthenticationClient();
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.callbackUrl = callbackUrl;
        this.cache = {
            accessToken: null,
            refreshToken: null,
            expiresAt: 0
        };
    }

    getAuthorizationUrl() {
        return this.authClient.authorize(this.clientId, ResponseType.Code, this.callbackUrl, SCOPES);
    }

    async exchangeAuthCode(code) {
        const credentials = await this.authClient.getThreeLeggedToken(this.clientId, code, this.callbackUrl, { clientSecret: this.clientSecret });
        this.cache.accessToken = credentials.access_token;
        this.cache.refreshToken = credentials.refresh_token;
        this.cache.expiresAt = Date.now() + credentials.expires_in * 1000;
    }

    async refreshAccessToken(refreshToken) {
        const credentials = await this.authClient.refreshToken(refreshToken, this.clientId, { clientSecret: this.clientSecret });
        this.cache.accessToken = credentials.access_token;
        this.cache.refreshToken = credentials.refresh_token;
        this.cache.expiresAt = Date.now() + credentials.expires_in * 1000;
    }

    async getAccessToken() {
        if (this.cache.accessToken && this.cache.expiresAt > Date.now() + 60 * 1000) { // refresh a minute early to absorb clock skew and request latency
            return this.cache.accessToken;
        } else if (this.cache.refreshToken) {
            await this.refreshAccessToken(this.cache.refreshToken);
            return this.cache.accessToken;
        } else {
            throw new Error('Not authenticated');
        }
    }
}

export async function getHubsProjects(authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data: hubs = [] } = await client.getHubs();
    return Promise.all(hubs.map(async hub => {
        const { data: projects = [] } = await client.getHubProjects(hub.id);
        return {
            id: hub.id,
            name: hub.attributes.name,
            region: hub.attributes.region,
            projects: projects.map(p => ({ id: p.id, name: p.attributes.name }))
        };
    }));
}

export async function getFolderContents(authenticationProvider, hubId, projectId, folderId) {
    const client = new DataManagementClient({ authenticationProvider });
    // TODO: only the first page of results is returned; folders with more than 200 children need pagination via links.next
    const { data: items = [] } = folderId
        ? await client.getFolderContents(projectId, folderId)
        : await client.getProjectTopFolders(hubId, projectId);
    return items.filter(isVisible).map(toFolderEntry);
}

export const RCW_ITEM_TYPE = 'items:autodesk.bim360:C4RModel';
export const RCW_VERSION_TYPE = 'versions:autodesk.bim360:C4RModel';

const isVisible = (item) => !item.attributes.hidden; // skip entries the Forma UI hides, e.g. system folders

export function toFolderEntry(item) {
    return {
        type: item.type,
        id: item.id,
        name: item.attributes.displayName,
        extensionType: item.attributes.extension?.type,
        modifiedAt: item.attributes.lastModifiedTime,
        modifiedBy: item.attributes.lastModifiedUserName
    };
}

export async function getItemTip(authenticationProvider, projectId, itemId) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data } = await client.getItemTip(projectId, itemId);
    return {
        name: data.attributes.displayName,
        derivativeUrn: data.relationships?.derivatives?.data?.id,
        storageId: data.relationships?.storage?.data?.id,
        versionType: data.attributes.extension?.type
    };
}

const folderName = (folder) => folder.attributes.displayName ?? folder.attributes.name;

// Human-readable path like "Project Files / AU 2026 Demo / Sub", so callers can verify where a folder really is.
// Several folders may share a name (e.g. "Revit Cloud Modes Sample Folder"), so IDs alone are easy to mix up.
export async function getFolderPath(authenticationProvider, projectId, folderId, maxDepth = 12, client = new DataManagementClient({ authenticationProvider })) {
    let { data: folder } = await client.getFolder(projectId, folderId);
    const names = [folderName(folder)];
    for (let i = 0; i < maxDepth; i++) {
        let parent;
        try {
            ({ data: parent } = await client.getFolderParent(projectId, folder.id));
        } catch {
            break; // top-level folders have no parent
        }
        if (!parent) break;
        names.unshift(folderName(parent));
        folder = parent;
    }
    return names.join(' / ');
}

export async function getItemFolderPath(authenticationProvider, projectId, itemId) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data: parent } = await client.getItemParentFolder(projectId, itemId);
    return getFolderPath(authenticationProvider, projectId, parent.id);
}

const FOLDER_EXTENSION = { type: 'folders:autodesk.bim360:Folder', version: '1.0' };
const PAGE_LIMIT = 200;

// All child folders of a folder, following pagination so a name match is never missed (a miss would create a duplicate).
async function listChildFolders(client, projectId, folderId) {
    const folders = [];
    for (let pageNumber = 0; ; pageNumber++) {
        const { data = [] } = await client.getFolderContents(projectId, folderId, { filterType: ['folders'], pageNumber, pageLimit: PAGE_LIMIT });
        folders.push(...data);
        if (data.length < PAGE_LIMIT) return folders;
    }
}

// Resolves a slash-separated path under a parent folder, creating whatever segments are missing.
// Only ACC/BIM 360 projects ("b." IDs) are supported; personal hubs use a different folder model.
export async function ensureFolderPath(authenticationProvider, projectId, parentFolderId, folderPath, client = new DataManagementClient({ authenticationProvider })) {
    if (!projectId.startsWith('b.')) throw new Error('create-folder only supports ACC/BIM 360 projects (IDs starting with "b.").');
    const segments = folderPath.split('/').map(s => s.trim()).filter(Boolean);
    if (!segments.length) throw new Error('folderPath must contain at least one folder name.');
    let currentId = parentFolderId;
    const created = [];
    for (const name of segments) {
        const find = async () => (await listChildFolders(client, projectId, currentId))
            .find(f => folderName(f).toLowerCase() === name.toLowerCase()); // ACC folder names are case-insensitive
        let folder = await find();
        if (!folder) {
            try {
                ({ data: folder } = await client.createFolder(projectId, {
                    jsonapi: { version: '1.0' },
                    data: {
                        type: 'folders',
                        attributes: { name, extension: FOLDER_EXTENSION },
                        relationships: { parent: { data: { type: 'folders', id: currentId } } }
                    }
                }));
                created.push(name);
            } catch (err) {
                if (err?.axiosError?.response?.status !== 409) throw err;
                folder = await find(); // lost a race with another creator; reuse their folder
                if (!folder) throw err;
            }
        }
        currentId = folder.id;
    }
    return { folderId: currentId, path: await getFolderPath(authenticationProvider, projectId, currentId, undefined, client), created };
}

const userIdCache = new Map();

// Stable APS user ID of the signed-in user, used to scope migration jobs to their owner.
export async function getUserId(authenticationProvider) {
    const accessToken = await authenticationProvider.getAccessToken();
    if (!userIdCache.has(accessToken)) {
        const { sub } = await new AuthenticationClient().getUserInfo(accessToken);
        userIdCache.set(accessToken, sub);
    }
    return userIdCache.get(accessToken);
}
