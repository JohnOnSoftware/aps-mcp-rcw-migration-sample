// Usage: npm run setup-da [-- --versions 2026,2027] [--dry-run]
import { access, readFile } from 'node:fs/promises';
import { REVIT_VERSIONS, getDaConfig, listRevitEngines, setupVersion } from '../automation.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const versionsArg = args[args.indexOf('--versions') + 1];
const requested = args.includes('--versions') ? versionsArg.split(',').map((v) => v.trim()) : Object.keys(REVIT_VERSIONS);

const unknown = requested.filter((v) => !REVIT_VERSIONS[v]);
if (unknown.length) {
    console.error(`Unknown Revit version(s): ${unknown.join(', ')}. Supported: ${Object.keys(REVIT_VERSIONS).join(', ')}`);
    process.exit(1);
}
if (!process.env.APS_CLIENT_ID || !process.env.APS_CLIENT_SECRET) {
    console.error('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.');
    process.exit(1);
}

const bundleUrl = (name) => new URL(`../bundles/${name}`, import.meta.url);
const config = getDaConfig();
const engines = await listRevitEngines();
console.log(`Design Automation: ${config.baseUrl} (nickname: ${config.nickname}, alias: ${config.alias})`);

const results = [];
for (const version of requested) {
    const { engine, bundleZip } = REVIT_VERSIONS[version];
    const skip = async () => {
        if (!engines.includes(engine)) return `engine ${engine} is not available`;
        try { await access(bundleUrl(bundleZip)); } catch { return `bundle bundles/${bundleZip} not found`; }
        return null;
    };
    const reason = await skip();
    if (reason) {
        results.push({ version, result: `skipped: ${reason}` });
        continue;
    }
    if (dryRun) {
        results.push({ version, result: 'ready (dry run, nothing changed)' });
        continue;
    }
    try {
        const r = await setupVersion(version, { readBundle: (name) => readFile(bundleUrl(name)), config });
        results.push({ version, result: `bundle ${r.bundleAction}, activity ${r.activityAction}` });
    } catch (err) {
        results.push({ version, result: `failed: ${err.message}` });
    }
}

console.table(results);
if (results.some((r) => r.result.startsWith('failed'))) process.exit(1);
