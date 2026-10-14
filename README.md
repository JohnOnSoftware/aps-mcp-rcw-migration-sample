# APS MCP Server (Advanced)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes Autodesk Forma project data over **Streamable HTTP**, acting on behalf of a signed-in Autodesk user. Built for the AU2026 advanced workshop, starting from the code the [beginner session](https://github.com/autodesk-platform-services/au2026-mcp-workshop-beginner) produces.

## What it does

The server connects GitHub Copilot (or any MCP-compatible client) to the hubs and projects *the signed-in user* can see, can render designs as interactive 3D previews directly in chat, and can **migrate Revit Cloud Worksharing (RCW) models** between folders or projects — upgrading them to a newer Revit version — through Design Automation for Revit. Clients must sign in through the server's own OAuth endpoints before they can call a tool.

### MCP tools

| Tool | Inputs | Description |
| --- | --- | --- |
| `list-hubs-projects` | — | Lists all hubs and their projects accessible to the authenticated user |
| `list-folder-contents` | `hubId`, `projectId`, `folderId?` | Lists folder contents; omit `folderId` to get top-level folders. Each entry includes `extensionType`, so RCW models show up as `items:autodesk.bim360:C4RModel` |
| `create-folder` | `projectId`, `parentFolderId`, `folderPath` | Creates a folder or nested path in an ACC/BIM 360 project, reusing existing segments; only on explicit request |
| `preview-design` | `projectId`, `designId`, `region?` | Returns a payload the embedded APS Viewer UI uses to load the model |
| `check-migrator-setup` | — | Read-only. Reports, per Revit version (2025/2026/2027), whether the Design Automation engine and the RCW migrator activity are ready |
| `migrate-rcw-model` | `sourceProjectId`, `sourceItemId`, `targetHubId`, `targetProjectId`, `targetFolderId`, `targetName?`, `revitVersion?` | Copies an RCW model into another folder/project and upgrades it to `revitVersion` (default `2027`). Runs asynchronously and returns a `workItemId`; renders the migration progress UI |
| `get-migration-status` | `workItemIds` | Read-only. Returns `pending`, `inprogress`, `success`, `cancelled` or a `failed*` status per job; failed jobs include the tail of the Revit report log |
| `cancel-migration` | `workItemId` | Cancels a pending migration. A job that has already started may still complete |

Migration jobs are tracked in memory per signed-in user, so `get-migration-status` and `cancel-migration` only see the caller's own jobs, and the registry resets when the server restarts. Only RCW models are supported (linked models are not migrated), and a model cannot be downgraded — pick a Revit version at least as new as the source. See [docs/rcw-migration-implementation.md](docs/rcw-migration-implementation.md) for the full design.

### Viewer UI resource

`viewer.html` is registered as an MCP app resource under `ui://aps-mcp/viewer.html`. `preview-design` references it via `_meta.ui.resourceUri`, so a client that supports MCP Apps renders the viewer in a panel and feeds the tool's `structuredContent` to it. Selecting an object in 3D reports back to the host as extra model context.

### Migration UI resource

`migration.html` is registered under `ui://aps-mcp/migration.html` and bound to `migrate-rcw-model` the same way. It lists the submitted jobs, polls `get-migration-status` every 5 seconds (backing off after failed polls) until every job reaches a final state, and offers a cancel button on pending jobs.

There is no build step. `mcp.js` reads `viewer.html` and `migration.html` from disk at module load, and the one browser-side library the viewer needs is loaded from a CDN.

## Prerequisites

- Node.js 24+
- An APS application ([create one here](https://aps.autodesk.com/myapps)), with a **Callback URL** of `<PUBLIC_URL>/auth/callback`. The server requests the `data:read`, `data:write`, `data:create`, `account:read`, `account:write` and `user-profile:read` scopes; the write scopes let Revit save migrated models into the target project
- An Autodesk Forma hub your APS app is provisioned to, and membership of at least one project in it — the 3-legged flow uses *your* permissions. For migrations you also need write access to the target folder
- For RCW migration only: access to Design Automation for Revit (the APS app uses the `code:all` scope server-side) and, to migrate to a given Revit version, a one-time `npm run setup-da` run by an administrator

## Setup

Create a `.env` file at the project root:

```text
APS_CLIENT_ID=your-client-id
APS_CLIENT_SECRET=your-client-secret
```

Then:

```bash
npm install
npm start
```

| Variable | Required | Default |
| --- | --- | --- |
| `APS_CLIENT_ID` | yes | — |
| `APS_CLIENT_SECRET` | yes | — |
| `PORT` | no | `3000` |
| `PUBLIC_URL` | no | `http://localhost:<PORT>` |
| `APS_DA_REGION` | no | `us-east` (Design Automation region) |
| `APS_DA_NICKNAME` | no | `APS_CLIENT_ID` (Design Automation nickname) |
| `APS_DA_ALIAS` | no | `dev` (Design Automation alias) |

The `start` script loads `.env` via Node's `--env-file-if-exists` flag, so any of these can go there. `.env` is gitignored; the code only ever reads `process.env`. Where the variables are already in the environment — a Codespace with repository secrets, a container — no `.env` is needed and Node skips it.

`PUBLIC_URL` must match the **Callback URL** registered on the APS app, because the OAuth callback is served at `${PUBLIC_URL}/auth/callback`. Running locally, that's `http://localhost:3000/auth/callback` and the default `PUBLIC_URL` is already correct. In a Codespace, set `PUBLIC_URL` to the forwarded URL for port `3000`, register the matching callback, and set that port's visibility to **public** so the redirect can reach it.

### Design Automation setup (RCW migration)

The migration tools run a Revit add-in on Design Automation. Before the first migration, an administrator uploads the add-in bundle and creates one activity per Revit version:

```bash
npm run setup-da                          # all versions that have an engine and a bundle
npm run setup-da -- --versions 2026       # only specific versions
npm run setup-da -- --dry-run             # show what would be done
```

Use the `check-migrator-setup` tool afterwards to confirm each version reports `activityReady: true`. Migrations to a version that isn't ready are rejected, and the default target version is Revit 2027, so make sure 2027 is set up or pass `revitVersion` explicitly. The repo ships bundles for Revit 2025 and 2026 in `bundles/`; a 2027 bundle must be built from `plugin/` first (see below). Each migration consumes Design Automation (Flex) usage.

## VS Code integration

`.vscode/mcp.json` registers the server as **APS MCP Server (Advanced)** over HTTP at `http://localhost:3000/mcp`. Start the server first, then register it from that file — Copilot connects over the network rather than launching the process itself.

Because `/mcp` is guarded by bearer auth, a spec-compliant client discovers the sign-in flow from the `401` challenge and opens a browser prompt on its own. `.vscode/launch.json` runs the same entry point under the Node debugger, reading credentials from `.env` via `envFile`. In a Codespace, drop that `envFile` line and point both files at the forwarded hostname instead — see [Part 2 of the tutorial](docs/2-http-transport.md).

## Architecture

```text
index.js          Entry point — Express app, MCP handler, OAuth proxy router, bearer guard on /mcp
mcp.js            MCP server factory — registers tools + the viewer and migration resources, never calls server.connect()
aps.js            APS layer — 3-legged OAuth provider + Data Management helpers (hubs, folders, item tips, folder creation)
automation.js     Design Automation layer — 2-legged token, bundle/activity setup, workitem submit/status/cancel, in-memory job registry
migration-logic.js  Pure helpers for migration.html — inlined into the page by mcp.js and imported directly by the tests
proxy.js          OAuth authorization server in front of /mcp (demo-only, see below)
viewer.html       Self-contained APS Viewer panel, served as an MCP app resource
migration.html    Self-contained migration progress panel, served as an MCP app resource
scripts/setup-da.js  One-time admin script: uploads the app bundle and creates the Design Automation activities
bundles/          Pre-built RCWMigratorApp zips (Revit 2025, 2026)
plugin/           C# source of the Revit add-in that runs SaveAsCloudModel on Design Automation
test/             node:test suites for automation, folders, MCP tools and the migration UI
```

`UserAuthenticationProvider` (in `aps.js`) holds a user's access and refresh tokens and exposes a single `getAccessToken()` method — the same interface a 2-legged provider exposes, which is why the Data Management helpers work unchanged under either. Raw APS tokens never leave the class.

APS identity is resolved **per token**: `proxy.js` mints a `UserAuthenticationProvider` per authorization and attaches a bound `getAccessToken()` to each request's `authInfo`, so two clients never share a login.

> **`proxy.js` is a workshop stand-in, not production-ready.** It has no PKCE verification, no client authentication at `/token`, no rate limiting, no revocation, and no persistence — all state is in memory and resets on restart. It exists so the whole two-layer OAuth flow is readable in one file. Replace it with a purpose-built implementation or a dedicated identity provider before shipping.

## Tests

```bash
npm test
```

Runs the `node:test` suites in `test/` (no network access or credentials needed).

## Building the Revit add-in

`plugin/RCWMigrator.sln` builds the add-in that Design Automation runs. Package the output as `bundles/RCWMigratorApp-<version>.zip`, with `plugin/RCWMigratorApp.bundle/PackageContents.xml` and its `Contents/` folder, then run `npm run setup-da -- --versions <version>`. Note that `PackageContents.xml` currently declares `SeriesMin="R2025"` / `SeriesMax="R2026"`, so widen it when you build for Revit 2027.

## Tutorial

Step-by-step instructions for building this server from scratch are in the `docs/` folder. Serve them locally with:

```bash
npx serve docs -l 4000
```

Then open `http://localhost:4000` — port `3000` is left free for the MCP server itself.
