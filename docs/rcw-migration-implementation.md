# RCW 模型迁移功能 — 开发实现文档

把 [aps-revit-rcw-migrate-automation](https://github.com/autodesk-platform-services/aps-revit-rcw-migrate-automation) 的迁移能力移植到本 MCP 服务器：用户在 AI 客户端里用自然语言选择源 RCW 模型和目标文件夹，服务器通过 Design Automation for Revit 执行 `SaveAsCloudModel`，并用 MCP App 页面实时展示迁移进度。

## 1. 已确认的设计决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | AppBundle / Activity 配置方式 | 一次性脚本 `npm run setup-da`（管理员执行）+ 只读工具 `check-migrator-setup`。不暴露写操作给 MCP 用户 |
| 2 | 状态获取方式 | 轮询 Design Automation workitem 状态，不使用 webhook / ngrok / socket.io |
| 3 | Revit 版本 | 多版本支持：2025、2026、2027（每个版本一套 AppBundle + Activity） |
| 4 | 进度展示 | 新增 MCP App 页面 `migration.html`，在客户端内展示迁移进度 |

## 2. 原仓库功能映射

| 原仓库 | 作用 | 本项目中的去向 |
|---|---|---|
| `RCWMigratorPlugin/Command.cs` | DA 中打开模型，读取 `params.json`，调用 `doc.SaveAsCloudModel(accountGuid, projectGuid, folderUrn, modelName)` | C# 逻辑**不改**；源码放到 `plugin/` 作参考，按 Revit 版本编译出 bundle zip |
| `routes/automationConfig.js` | 创建 / 更新 AppBundle、Activity、Alias | `scripts/setup-da.js`（改为幂等，支持多版本） |
| `routes/revitAutomation.js` POST | 校验 C4RModel、取最新版本 storage、提交 workitem | 工具 `migrate-rcw-model` / `migrate-rcw-folder` |
| `routes/revitAutomation.js` GET / DELETE | 查询 / 取消 workitem | 工具 `get-migration-status` / `cancel-migration` |
| `/callback/designautomation` + socket.io | 完成通知推送到网页 | 删除；由 MCP App 页面调用 `get-migration-status` 轮询 |
| `routes/common/aps.js` `getHubFromProjectId` | 遍历所有 hub 找目标 hub | 删除；目标 `hubId` 由模型从 `list-hubs-projects` 结果中直接传入 |
| `wwwroot/` 前端（jQuery 树） | 选择源文件和目标文件夹 | 删除；由 `list-hubs-projects` / `list-folder-contents` 承担 |
| `autodesk.forge.designautomation`、`request` | DA SDK、HTTP | 不引入（均已过时）；用 Node 内置 `fetch` / `FormData` 直接调用 DA v3 REST |

## 3. 总体架构

```
AI 客户端 ──MCP──► mcp.js（工具注册 + UI 资源）
                     │
                     ├─ aps.js          用户 3-legged token：Data Management（查版本、校验类型、列目录）
                     └─ automation.js   应用 2-legged token：Design Automation v3（提交 / 查询 / 取消 workitem）
                                           │
                                           ▼
                                DA for Revit（revitcoreconsole + RCWMigrator.dll）
                                           │ SaveAsCloudModel（使用随 workitem 传入的用户 3-legged token）
                                           ▼
                                目标 ACC / BIM 360 项目文件夹

MCP App 页面 migration.html ──app.callServerTool('get-migration-status')──► mcp.js（每 5 秒轮询）
```

两套 token：

- **用户 3-legged token**（现有 OAuth 代理流程）：读取源模型版本信息；作为 `adsk3LeggedToken` 传给 workitem，让 Revit 以用户身份读取源模型、写入目标项目。
- **应用 2-legged token**（新增，scope `code:all`）：调用 DA API。只在服务器端使用，永不下发到客户端或 MCP App 页面。

## 4. 文件变更清单

| 文件 | 类型 | 内容 |
|---|---|---|
| `automation.js` | 新增 | 2-legged token 缓存、`daFetch`、引擎/Activity 查询、workitem 提交/查询/取消、报告日志截取、作业登记表 |
| `aps.js` | 修改 | 扩展 OAuth scopes；`getItemTip` 增加返回 `storageId`、`versionType`；`getFolderContents` 增加 `extensionType` 字段 |
| `mcp.js` | 修改 | 注册 5 个新工具 + `migration` UI 资源 |
| `migration.html` | 新增 | MCP App 进度页面 |
| `scripts/setup-da.js` | 新增 | 多版本 AppBundle / Activity 幂等配置脚本 |
| `bundles/RCWMigratorApp-2025.zip` 等 | 新增 | 各 Revit 版本的插件包 |
| `plugin/` | 新增 | 插件 C# 源码（从原仓库复制，2027 需调整，见 §5） |
| `package.json` | 修改 | 新增脚本 `"setup-da": "node --env-file-if-exists=.env scripts/setup-da.js"` |
| `README.md` | 修改 | 新增环境变量与 `setup-da` 使用说明 |

不新增任何 npm 依赖。

## 5. 插件包与多版本支持

### 5.1 现状

原仓库插件使用 `Autodesk.Revit.SDK 2026.0.0.9999` + `Autodesk.Forge.DesignAutomation.Revit 2026.0.0` 编译，目标框架 `net8.0-windows`；`PackageContents.xml` 声明 `SeriesMin="R2025" SeriesMax="R2026"`。原仓库用同一个 zip 服务 2025 和 2026 两个引擎。

### 5.2 版本配置

在 `automation.js` 中集中定义版本表，脚本和工具共用：

```js
export const REVIT_VERSIONS = {
    '2025': { engine: 'Autodesk.Revit+2025', bundleZip: 'RCWMigratorApp-2025.zip' },
    '2026': { engine: 'Autodesk.Revit+2026', bundleZip: 'RCWMigratorApp-2026.zip' },
    '2027': { engine: 'Autodesk.Revit+2027', bundleZip: 'RCWMigratorApp-2027.zip' },
};
export const DEFAULT_REVIT_VERSION = '2027';
```

命名规则（`<nickname>` 默认为 `APS_CLIENT_ID`，`<alias>` 默认为 `dev`）：

- AppBundle：`RCWMigrator<ver>AppBundle`，完整 ID `<nickname>.RCWMigrator<ver>AppBundle+<alias>`
- Activity：`RCWMigrator<ver>Activity`，完整 ID `<nickname>.RCWMigrator<ver>Activity+<alias>`

### 5.3 各版本插件包

- **2025 / 2026**：直接使用原仓库的 `RCWMigratorApp.zip`，复制为 `RCWMigratorApp-2025.zip` 和 `RCWMigratorApp-2026.zip`。
- **2027**：需要重新编译：
  1. NuGet 引用改为 `Autodesk.Revit.SDK 2027.*` 和 `Autodesk.Forge.DesignAutomation.Revit 2027.*`。
  2. `TargetFramework` 按 Revit 2027 要求调整（**待确认**：Revit 2027 API 要求的 .NET 版本）。
  3. `PackageContents.xml` 改为 `SeriesMin="R2027" SeriesMax="R2027"`。
  4. 在 Windows 上编译并打包为 `RCWMigratorApp-2027.zip`（zip 根目录为 `RCWMigratorApp.bundle/`）。
- **前置验证**：调用 `GET /da/us-east/v3/engines`，确认 `Autodesk.Revit+2027` 已上线；`setup-da` 脚本遇到不存在的引擎时跳过并提示，不中断其他版本。

### 5.4 版本选择规则

- `SaveAsCloudModel` 会把模型升级到引擎对应的 Revit 版本；**不能降级**。目标版本低于源模型版本时 workitem 会失败。
- 工具参数 `revitVersion` 可选，默认 `2027`。工具描述中要说明这一点，让模型在用户未指定时使用最新版本。
- 提交前校验所选版本对应的 Activity 已存在（缓存 `check` 结果 5 分钟），否则返回明确错误：「Revit 2027 迁移器尚未配置，请管理员运行 npm run setup-da」。

## 6. 认证改动

### 6.1 用户 3-legged scopes（`aps.js`）

```js
const SCOPES = [Scopes.DataRead, Scopes.DataWrite, Scopes.DataCreate, Scopes.AccountRead, Scopes.AccountWrite];
```

与原仓库一致（原仓库为 `data:read data:write account:read account:write`，另加 `data:create` 以覆盖新建 item）。功能跑通后逐项去掉 `account:write` / `account:read` 验证是否必需，保留最小集合。

**影响**：已登录的用户需要重新授权一次（现有 token 不含写权限）。

### 6.2 应用 2-legged token（`automation.js`）

```js
import { AuthenticationClient, Scopes } from '@aps_sdk/authentication';

const authClient = new AuthenticationClient();
let cached = { token: null, expiresAt: 0 };

export async function getAppToken() {
    if (cached.token && cached.expiresAt > Date.now() + 60 * 1000) return cached.token;
    const { access_token, expires_in } = await authClient.getTwoLeggedToken(
        process.env.APS_CLIENT_ID, process.env.APS_CLIENT_SECRET, [Scopes.CodeAll]);
    cached = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
    return cached.token;
}
```

### 6.3 ACC 前提

APS 应用的 Client ID 必须在**源和目标**两个 ACC / BIM 360 账户中添加为 Custom Integration，否则 Data Management 调用和 `SaveAsCloudModel` 都会失败。

## 7. Design Automation 配置脚本（`scripts/setup-da.js`）

用法：

```bash
npm run setup-da                       # 配置所有版本
npm run setup-da -- --versions 2026,2027
```

每个版本的执行流程（幂等，可重复运行）：

1. 查询 `GET /appbundles`：
   - 不存在：`POST /appbundles` → `POST /appbundles/{id}/aliases`（alias 指向 v1）
   - 已存在：`POST /appbundles/{id}/versions` → `PATCH /appbundles/{id}/aliases/{alias}`（指向新版本）
2. 用返回的 `uploadParameters` 上传 zip：`multipart/form-data`，先放所有 `formData` 字段，**`file` 字段放最后**（S3 要求）。用 Node 内置 `FormData` + `Blob`。
3. 查询 `GET /activities`：
   - 不存在：`POST /activities` → `POST /activities/{id}/aliases`
   - 已存在：`POST /activities/{id}/versions` → `PATCH` alias（与原仓库不同：原仓库已存在时直接跳过，导致修改 commandLine 后不生效）
4. 输出每个版本的结果汇总表。

Activity 定义：

```js
{
    id: `RCWMigrator${ver}Activity`,
    engine: REVIT_VERSIONS[ver].engine,
    appbundles: [`${nickname}.RCWMigrator${ver}AppBundle+${alias}`],
    commandLine: [`$(engine.path)\\\\revitcoreconsole.exe /i "$(args[rvtFile].path)" /al "$(appbundles[RCWMigrator${ver}AppBundle].path)"`],
    parameters: {
        rvtFile:     { verb: 'get', description: 'Input Revit cloud model', required: false },
        inputParams: { verb: 'get', description: 'Target location JSON', localName: 'params.json', required: false },
    },
    description: `Migrate Revit Cloud Worksharing model (Revit ${ver})`,
}
```

DA 基础地址：`https://developer.api.autodesk.com/da/us-east/v3`。

## 8. MCP 工具设计

所有工具沿用 `mcp.js` 现有风格：`server.registerTool(name, { title, description, inputSchema: z.object(...), annotations }, handler)`。

### 8.1 `check-migrator-setup`（只读）

- 输入：无
- 逻辑：查询引擎列表与本应用的 Activity 列表，对每个版本给出状态
- 输出：

```json
[
  { "revitVersion": "2025", "engineAvailable": true,  "activityReady": true },
  { "revitVersion": "2027", "engineAvailable": true,  "activityReady": false }
]
```

### 8.2 `migrate-rcw-model`

| 参数 | 类型 | 说明 |
|---|---|---|
| `sourceProjectId` | string | 源项目 ID（`b.` 前缀） |
| `sourceItemId` | string | 源 RCW 模型 item ID |
| `targetHubId` | string | 目标 hub ID（`b.` 前缀） |
| `targetProjectId` | string | 目标项目 ID |
| `targetFolderId` | string | 目标文件夹 URN |
| `targetName` | string? | 目标模型名，默认沿用源文件名 |
| `revitVersion` | enum `2025`/`2026`/`2027`? | 默认 `2027` |

处理流程：

1. `getItemTip(sourceProjectId, sourceItemId)` 获取最新版本。
2. 校验 `versionType === 'versions:autodesk.bim360:C4RModel'`，否则返回错误「仅支持 Revit Cloud Worksharing 模型」。
3. 校验 `revitVersion` 对应 Activity 已就绪（§5.4）。
4. 组装 workitem（与原仓库参数格式保持一致）：

```js
const params = {
    TargetAccountGuid: targetHubId.replace(/^b\./, ''),
    TargetProjectGuid: targetProjectId.replace(/^b\./, ''),
    TargetFolderUrn: targetFolderId,
    TargetModelName: targetName ?? tip.name,
};
const userToken = await authenticationProvider.getAccessToken();
const workitem = {
    activityId: `${nickname}.RCWMigrator${revitVersion}Activity+${alias}`,
    arguments: {
        rvtFile: { url: tip.storageId, headers: { Authorization: `Bearer ${userToken}` } },
        inputParams: { url: 'data:application/json,' + JSON.stringify(params) },
        adsk3LeggedToken: userToken,
    },
};
```

> 原仓库为了嵌入 data URL 把双引号替换为单引号。实现时先按标准 JSON（`encodeURIComponent` 编码）测试；若插件解析失败，再回退为原仓库的单引号写法。

5. `POST /workitems`，把作业写入作业登记表（§9）。
6. 返回 `structuredContent`（供 UI 渲染）和简短文本：

```json
{
  "jobs": [{
    "workItemId": "abc123",
    "fileName": "Tower.rvt",
    "revitVersion": "2027",
    "target": { "projectId": "b.xxx", "folderId": "urn:..." },
    "status": "pending",
    "submittedAt": "2026-10-14T10:00:00Z"
  }]
}
```

- `_meta: { ui: { resourceUri: 'ui://aps-mcp/migration.html' } }`
- `annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }`

### 8.3 `migrate-rcw-folder`

- 输入：`sourceProjectId`、`sourceFolderId`，加上 §8.2 中的目标参数与 `revitVersion`（无 `targetName`）
- 逻辑：列出源文件夹（**不递归**），筛选 `extensionType === 'items:autodesk.bim360:C4RModel'`，**最多 5 个**（保留原仓库限制，超出时返回错误并列出文件数，让用户缩小范围）；逐个复用 §8.2 的提交逻辑
- 输出：与 §8.2 相同结构，`jobs` 包含多项；另附 `skipped`（非 RCW 文件名列表）
- 同样绑定 `migration.html`

### 8.4 `get-migration-status`（只读）

- 输入：`workItemIds: string[]`
- 逻辑：校验每个 ID 属于当前用户（§9），调用 `GET /workitems/{id}`
- 失败状态（`failed*`）时，下载 `reportUrl` 并截取**最后 40 行**放入 `reportTail`，方便模型解释失败原因
- 输出：

```json
{
  "jobs": [{
    "workItemId": "abc123",
    "fileName": "Tower.rvt",
    "status": "failedInstructions",
    "progress": null,
    "reportTail": "...Failed to save cloud model due to: ..."
  }]
}
```

- 同时供模型和 MCP App 页面调用：`_meta: { ui: { visibility: ['model', 'app'] } }`

DA 状态值：`pending`、`inprogress`、`success`、`cancelled`、`failedDownload`、`failedInstructions`、`failedUpload`、`failedUploadOptional`、`failedLimitDataSize`、`failedLimitProcessingTime`。终态 = 除 `pending` / `inprogress` 外的所有值。

### 8.5 `cancel-migration`

- 输入：`workItemId`
- 逻辑：校验归属后 `DELETE /workitems/{id}`；更新登记表状态为 `cancelled`
- 说明：已进入 `inprogress` 的任务可能无法取消，返回信息中注明
- `annotations: { destructiveHint: true }`；`_meta.ui.visibility: ['model', 'app']`（页面上的取消按钮会调用）

### 8.6 现有工具改动

`list-folder-contents` 输出每项新增 `extensionType`（`item.attributes.extension.type`），模型据此识别 RCW 模型（`items:autodesk.bim360:C4RModel`）。

## 9. 作业登记表与安全

`automation.js` 中维护内存 `Map<workItemId, Job>`：

```js
{ workItemId, ownerKey, fileName, revitVersion, source, target, status, submittedAt, finishedAt }
```

- **归属校验**：`ownerKey` 取当前 MCP 会话的 `clientId` + APS 用户 ID（通过 `getUserInfo` 获取一次后缓存）。`get-migration-status` / `cancel-migration` 只允许操作自己的作业，防止用户 A 查询或取消用户 B 的任务。
- 服务器重启后登记表丢失：对未知 ID 返回「作业不存在或服务器已重启」，**不**回退为无校验查询。
- 终态作业保留 24 小时后清理。
- 2-legged token、用户 token 均不出现在任何工具返回值和 UI 中。

## 10. MCP App 进度页面（`migration.html`）

### 10.1 资源注册（`mcp.js`）

参照现有 viewer 资源：

```js
const MIGRATION_RESOURCE_URI = 'ui://aps-mcp/migration.html';
server.registerResource('migration', MIGRATION_RESOURCE_URI, { mimeType: 'text/html;profile=mcp-app' }, async (uri) => ({
    contents: [{
        uri: uri.toString(),
        mimeType: 'text/html;profile=mcp-app',
        text: MIGRATION_HTML,
        _meta: { ui: { domain: publicUrl, csp: { resourceDomains: ['https://cdn.jsdelivr.net'], connectDomains: [] } } },
    }],
}));
```

页面不直接访问任何 APS 域名，所有数据都经由 `callServerTool` 获取，所以 `connectDomains` 为空。

### 10.2 页面行为

```
┌──────────────────────────────────────────────────────────┐
│ RCW 模型迁移 → Revit 2027              2/3 完成          │
├──────────────────────────────────────────────────────────┤
│ Tower.rvt        ● 成功       00:03:12                   │
│ Podium.rvt       ◐ 处理中     00:01:40        [取消]     │
│ Site.rvt         ✕ 失败       failedInstructions [详情]  │
└──────────────────────────────────────────────────────────┘
```

1. `app.ontoolresult` 接收 `migrate-rcw-model` / `migrate-rcw-folder` 返回的 `structuredContent.jobs`，渲染列表。
2. 每 5 秒调用 `app.callServerTool({ name: 'get-migration-status', arguments: { workItemIds } })`，只轮询未到终态的作业；全部到终态后停止。
3. 状态显示：`pending`=排队中、`inprogress`=处理中、`success`=成功、`cancelled`=已取消、`failed*`=失败（显示具体状态码）；每行显示已用时间。
4. 失败行的「详情」展开 `reportTail`。
5. `pending` / `inprogress` 行显示「取消」按钮 → `callServerTool('cancel-migration')`。
6. 全部完成后调用 `app.updateModelContext()`，写入汇总文本（如「3 个模型中 2 个成功，Site.rvt 失败：failedInstructions」），让模型能直接回答后续问题。
7. 轮询失败（网络错误）时指数退避（5s → 10s → 20s，上限 60s），页面顶部显示提示，不中断。
8. 样式保持简洁，适配客户端浅色和深色主题（使用 `prefers-color-scheme`）。

## 11. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `APS_CLIENT_ID` / `APS_CLIENT_SECRET` | 是 | — | 已有 |
| `APS_DA_NICKNAME` | 否 | `APS_CLIENT_ID` | APS 应用设置了 DA nickname 时使用 |
| `APS_DA_ALIAS` | 否 | `dev` | AppBundle / Activity 的 alias |
| `APS_DA_REGION` | 否 | `us-east` | DA 区域 |

不再需要原仓库的 `APS_WEBHOOK_URL`、`APS_CALLBACK_URL`、`SERVER_SESSION_SECRET`。

## 12. 实施步骤

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| 1 | 复制插件源码与 2025/2026 zip；实现 `automation.js` 基础部分（token、`daFetch`）与 `setup-da.js` | `npm run setup-da -- --versions 2026` 成功；DA 中可见 bundle 与 activity |
| 2 | 实现 `check-migrator-setup` | 工具返回各版本状态正确 |
| 3 | 扩展 scopes；`aps.js` 增加 `storageId` / `versionType` / `extensionType` | 重新登录后 `list-folder-contents` 能识别 RCW 模型 |
| 4 | 实现 `migrate-rcw-model`、`get-migration-status`、`cancel-migration`（先只返回文本） | 端到端迁移一个模型成功，目标文件夹出现新模型 |
| 5 | 实现 `migration.html` 并绑定到迁移工具 | 客户端内看到实时进度，取消按钮可用，完成后模型能读到汇总 |
| 6 | 实现 `migrate-rcw-folder` | 一次迁移 2–5 个模型，进度页面正确显示多行 |
| 7 | 编译 2027 插件包，`setup-da -- --versions 2027` | 2027 迁移端到端成功 |
| 8 | 精简 scopes，更新 README | 最小 scope 集合下全部用例通过 |

## 13. 测试用例

测试环境：DAS - Canada hub → `AU 2026 RCW Demo Project` → `Project Files`（源：`Sample -001`，目标：`AU 2026 Demo`）。

| # | 场景 | 预期 |
|---|---|---|
| 1 | 迁移单个 RCW 模型到同项目另一文件夹（2026） | `success`，目标文件夹出现同名模型 |
| 2 | 跨项目迁移（同 hub） | `success` |
| 3 | 默认版本（不传 `revitVersion`） | 使用 2027 |
| 4 | 源为普通 RVT / PDF | 提交前拒绝，提示仅支持 RCW |
| 5 | 目标版本低于源模型版本 | workitem 失败，`reportTail` 包含原因，模型能解释 |
| 6 | 用户对目标文件夹无写权限 | workitem 失败，错误信息可读 |
| 7 | 目标版本 Activity 未配置 | 提交前拒绝，提示运行 `setup-da` |
| 8 | 文件夹迁移，含 3 个 RCW + 2 个其他文件 | 提交 3 个，`skipped` 列出 2 个 |
| 9 | 文件夹内 RCW 超过 5 个 | 拒绝并提示 |
| 10 | 在 `pending` 状态取消 | 状态变为 `cancelled`，页面同步 |
| 11 | 用另一账号查询/取消他人 workItemId | 拒绝 |
| 12 | 服务器重启后查询旧 workItemId | 返回「作业不存在或服务器已重启」 |
| 13 | `setup-da` 重复运行 | 生成新版本并更新 alias，无报错 |

## 14. 风险与待确认事项

| 项 | 说明 | 应对 |
|---|---|---|
| Revit 2027 引擎与 .NET 版本 | 需确认 DA 已提供 `Autodesk.Revit+2027`，以及 2027 插件的目标框架 | 阶段 7 前查询 `/engines` 并查阅 Revit 2027 API 文档 |
| 用户 token 有效期约 1 小时 | 作为 `adsk3LeggedToken` 传入，大模型排队 + 处理超过 1 小时可能失败 | 提交时获取最新 token；在工具描述中提示大模型风险；后续可评估 DA 对 token 刷新的支持 |
| DA 计费 | 每个 workitem 消耗 APS Flex token | 保留单次最多 5 个文件的限制；README 中注明 |
| 内存登记表 | 重启丢失，多实例部署不共享 | 当前为 workshop 规模，可接受；生产部署时改用持久化存储 |
| `inputParams` data URL 格式 | 标准 JSON 与原仓库单引号写法的兼容性 | 阶段 4 实测确认 |
| 链接模型 | 原仓库明确不支持迁移链接的 Revit 模型 | 在工具描述中注明 |
