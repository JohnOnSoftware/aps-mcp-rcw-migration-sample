// Pure helpers for migration.html. mcp.js inlines this file into the page (stripping `export`), and the tests import it directly.

const ACTIVE = new Set(['pending', 'inprogress']);

export const isTerminal = (status) => !ACTIVE.has(status);

export function statusInfo(status) {
    switch (status) {
        case 'pending': return { label: 'Queued', kind: 'active' };
        case 'inprogress': return { label: 'In progress', kind: 'active' };
        case 'success': return { label: 'Succeeded', kind: 'success' };
        case 'cancelled': return { label: 'Cancelled', kind: 'cancelled' };
        default: return { label: `Failed (${status})`, kind: 'failed' };
    }
}

// Exponential backoff for failed polls: 5s, 10s, 20s, 40s, then 60s.
export function nextDelay(consecutiveFailures, baseMs = 5000, maxMs = 60000) {
    return Math.min(baseMs * 2 ** consecutiveFailures, maxMs);
}

export function formatElapsed(startIso, endIso, nowMs) {
    const end = endIso ? Date.parse(endIso) : nowMs;
    const total = Math.max(0, Math.floor((end - Date.parse(startIso)) / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

// Keeps list order; updates known jobs in place and appends new ones.
export function mergeJobs(existing, incoming) {
    const merged = existing.map((job) => incoming.find((j) => j.workItemId === job.workItemId) ?? job);
    for (const job of incoming) if (!merged.some((j) => j.workItemId === job.workItemId)) merged.push(job);
    return merged;
}

export function summarize(jobs) {
    const done = jobs.filter((j) => isTerminal(j.status));
    const ok = jobs.filter((j) => j.status === 'success').length;
    const failed = done.filter((j) => statusInfo(j.status).kind === 'failed');
    const cancelled = done.filter((j) => j.status === 'cancelled').length;
    const parts = [`${ok} of ${jobs.length} migration(s) succeeded`];
    if (cancelled) parts.push(`${cancelled} cancelled`);
    for (const j of failed) parts.push(`${j.fileName} failed: ${j.status}`);
    return parts.join('; ') + '.';
}
