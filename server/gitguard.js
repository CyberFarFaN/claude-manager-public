/**
 * GitGuard indicator — per-instance status of the GitGuard pre-commit gate
 * baked into the workspace image (https://github.com/CyberFarFaN/GitGuard).
 *
 * The manager PULLS: it runs GitGuard's own CLI inside each running instance
 * over the Docker exec API it already uses (execCapture). Containers get no new
 * endpoint to write to, and nothing here listens for them.
 *
 *   gitguard status --json                  schema gitguard.status/v1
 *   gitguard events --json --limit N        schema gitguard.events/v1
 *   gitguard report --root /workspace --output <file> --json
 *
 * EVERYTHING READ FROM A CONTAINER IS UNTRUSTED: the agent inside controls the
 * binary, the files and the output. Every document goes through a parse* function
 * below, which copies an allow-list of fields with fixed types and length caps
 * into fresh objects. Nothing else from the container reaches the API or the UI.
 * GitGuard's events never carry secret values; the allow-list keeps it that way
 * even if a container tried to send one.
 */
import crypto from 'crypto';
import { config } from './config.js';
import { listManagedContainers, execCapture } from './docker.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('gitguard');

export const GITGUARD_BIN = '/usr/local/bin/gitguard';
const STATUS_TIMEOUT_MS = 60_000;
const REPORT_TIMEOUT_MS = 10 * 60_000;
const MAX_JSON_BYTES = 1_048_576;            // 1 MiB per JSON document
export const MAX_REPORT_BYTES = 20 * 1_048_576; // 20 MiB HTML report
const REPORT_TTL_MS = 10 * 60_000;
const MAX_STORED_REPORTS = 10;
export const MAX_EVENTS = 200;

// ---------------------------------------------------------------------------
// Sanitisers — pure, exported for tests
// ---------------------------------------------------------------------------

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$/;
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v, max = 1e9) => (Number.isInteger(v) && v >= 0 && v <= max ? v : 0);
const bool = (v) => v === true;
const iso = (v) => (typeof v === 'string' && ISO_UTC.test(v) ? v : '');
const oneOf = (v, allowed, fallback = '') => (allowed.includes(v) ? v : fallback);
const ident = (v, max = 60) => (typeof v === 'string' && /^[A-Za-z0-9._:/-]+$/.test(v) ? v.slice(0, max) : '');
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function parseJson(text, schema) {
  const s = Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? '');
  if (s.length > MAX_JSON_BYTES) return { error: 'output too large' };
  let doc;
  try { doc = JSON.parse(s); } catch { return { error: 'output is not JSON' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'output is not a JSON object' };
  if (doc.schema !== schema) {
    return { error: doc.schema === 'gitguard.error/v1' ? `gitguard error: ${str(doc.error, 300)}` : `unexpected schema ${str(doc.schema, 60) || '(none)'}` };
  }
  return { doc };
}

/** gitguard status --json -> sanitised status, or { error }. */
export function parseStatus(text) {
  const { doc, error } = parseJson(text, 'gitguard.status/v1');
  if (error) return { error };
  const gg = obj(doc.gitguard);
  const installed = obj(gg.installed);
  const policy = obj(doc.policy);
  const hooks = obj(doc.hooks);
  const events = obj(doc.events);
  return {
    healthy: bool(doc.healthy),
    generatedAt: iso(doc.generated_at),
    version: str(gg.version, 40),
    commit: str(installed.commit, 40).replace(/[^0-9a-f]/g, ''),
    policyEnforced: bool(policy.enforced),
    hooksOwned: bool(hooks.owned_by_gitguard),
    hooksPath: str(hooks.effective_path, 300),
    hooksScope: str(hooks.effective_scope, 20),
    blockedTotal: int(events.blocked_total),
    scanners: arr(doc.scanners, 20).map((s) => {
      const o = obj(s);
      return {
        name: ident(o.name, 40),
        version: str(o.version, 40),
        present: bool(o.present),
        required: bool(o.required),
        wired: bool(o.wired),
        error: str(o.error, 300),
      };
    }).filter((s) => s.name),
    problems: arr(doc.problems, 50).map((p) => {
      const o = obj(p);
      return {
        severity: oneOf(o.severity, ['error', 'warning'], 'error'),
        code: ident(o.code, 40),
        message: str(o.message, 300),
      };
    }),
  };
}

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const REASONS = ['findings', 'scanner_failure', 'policy_error', 'user_blocked'];

/** gitguard events --json -> { events, total }, or { error }. Never a finding value. */
export function parseEvents(text) {
  const { doc, error } = parseJson(text, 'gitguard.events/v1');
  if (error) return { error };
  return {
    total: int(doc.total_matching),
    events: arr(doc.events, MAX_EVENTS).map((e) => {
      const o = obj(e);
      return {
        id: ident(o.id, 64),
        timestamp: iso(o.timestamp),
        reason: oneOf(o.reason, REASONS, 'findings'),
        repo: str(o.repo, 300),
        branch: str(o.branch, 120),
        findings: arr(o.findings, 20).map((f) => {
          const x = obj(f);
          return {
            scanner: str(x.scanner, 40),
            ruleId: str(x.rule_id, 120),
            category: str(x.category, 40),
            severity: oneOf(x.severity, SEVERITIES, 'INFO'),
            file: str(x.file, 300),
            line: int(x.line),
          };
        }),
        scannerFailures: arr(o.scanner_failures, 10).map((f) => {
          const x = obj(f);
          return { scanner: str(x.scanner, 40), reason: str(x.reason, 300) };
        }),
      };
    }),
  };
}

/** gitguard report ... --json -> sanitised result, or { error }. */
export function parseReportResult(text) {
  const { doc, error } = parseJson(text, 'gitguard.report-result/v1');
  if (error) return { error };
  const sev = obj(doc.by_severity);
  return {
    findingsTotal: int(doc.findings_total),
    repos: arr(doc.repos, 1000).length,
    bySeverity: Object.fromEntries(SEVERITIES.map((k) => [k.toLowerCase(), int(sev[k])])),
  };
}

/**
 * Collapse one status exec into the badge state.
 *   healthy   GitGuard ran and says healthy (exit 0 AND healthy:true)
 *   unhealthy GitGuard ran and says otherwise, or its output was unusable
 *   missing   no GitGuard in the image (exec could not find the binary)
 *   unknown   not running, not checked yet, or Docker itself failed
 */
export function classifyStatus({ exitCode, stdout, error } = {}) {
  if (error) return { state: 'unknown', reason: str(error, 200) };
  if (exitCode === 126 || exitCode === 127) return { state: 'missing', reason: 'gitguard is not installed in this instance' };
  const status = parseStatus(stdout);
  if (status.error) return { state: 'unhealthy', reason: status.error };
  if (exitCode === 0 && status.healthy) return { state: 'healthy', reason: '', status };
  const firstError = status.problems.find((p) => p.severity === 'error');
  return { state: 'unhealthy', reason: firstError?.message || `gitguard status exited ${exitCode}`, status };
}

// ---------------------------------------------------------------------------
// Exec wrappers
// ---------------------------------------------------------------------------

async function runStatus(id) {
  try {
    const r = await execCapture(id, [GITGUARD_BIN, 'status', '--json'], { timeoutMs: STATUS_TIMEOUT_MS, maxBytes: MAX_JSON_BYTES });
    if (r.truncated) return { exitCode: r.exitCode, stdout: '', error: null, truncated: true };
    return { exitCode: r.exitCode, stdout: r.stdout };
  } catch (err) {
    // OCI runtime "executable file not found" surfaces as an exec start error
    if (/executable file not found|no such file or directory/i.test(err.message || '')) return { exitCode: 127, stdout: '' };
    return { error: err.code === 'ETIMEDOUT' ? 'gitguard status timed out' : 'could not reach the instance' };
  }
}

function toSummary(c, checkedAt = new Date().toISOString()) {
  return {
    state: c.state,
    reason: c.reason || '',
    blocked: c.status?.blockedTotal ?? 0,
    version: c.status?.version || '',
    checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Poller + cache (badge data for GET /api/instances)
// ---------------------------------------------------------------------------

const cache = new Map(); // instanceId -> summary
let timer = null;
let tickInProgress = false;
let broadcastFn = () => {};

export function gitguardEnabled() {
  return config.GITGUARD_POLL_INTERVAL_SECONDS > 0;
}

/** Badge summary for the instance list. null = feature off (no badge). */
export function getGitGuardSummary(instanceId, containerState) {
  if (!gitguardEnabled()) return null;
  if (containerState && containerState !== 'running') {
    return { state: 'unknown', reason: 'instance is not running', blocked: cache.get(instanceId)?.blocked ?? 0, version: '', checkedAt: '' };
  }
  return cache.get(instanceId) || { state: 'unknown', reason: 'not checked yet', blocked: 0, version: '', checkedAt: '' };
}

function setSummary(id, summary) {
  const prev = cache.get(id);
  cache.set(id, summary);
  const same = prev && prev.state === summary.state && prev.blocked === summary.blocked && prev.reason === summary.reason;
  if (!same) broadcastFn({ type: 'gitguard', instanceId: id, state: summary.state, blocked: summary.blocked });
}

export async function pollOnce() {
  const containers = await listManagedContainers();
  const seen = new Set();
  for (const c of containers) {
    seen.add(c.id);
    if (c.state !== 'running') continue;
    setSummary(c.id, toSummary(classifyStatus(await runStatus(c.id))));
  }
  for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
}

export function startGitGuardPoller(broadcast) {
  if (!gitguardEnabled()) return;
  broadcastFn = broadcast || (() => {});
  const tick = async () => {
    if (tickInProgress) return;
    tickInProgress = true;
    try { await pollOnce(); } catch (err) { log.error({ err }, 'gitguard poll failed'); } finally { tickInProgress = false; }
  };
  timer = setInterval(tick, config.GITGUARD_POLL_INTERVAL_SECONDS * 1000);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
  log.info(`GitGuard status poll every ${config.GITGUARD_POLL_INTERVAL_SECONDS}s`);
}

export function stopGitGuardPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------------------------------------------------------------------------
// Details for the panel (fresh, not cached)
// ---------------------------------------------------------------------------

export async function getGitGuardDetails(id, { eventsLimit = 100 } = {}) {
  const raw = await runStatus(id);
  const c = classifyStatus(raw);
  const summary = toSummary(c);
  if (gitguardEnabled()) setSummary(id, summary);

  let events = [];
  let eventsTotal = 0;
  let eventsError = '';
  if (c.state === 'healthy' || c.state === 'unhealthy') {
    const limit = String(Math.max(1, Math.min(MAX_EVENTS, eventsLimit | 0)));
    try {
      const r = await execCapture(id, [GITGUARD_BIN, 'events', '--json', '--limit', limit], { timeoutMs: STATUS_TIMEOUT_MS, maxBytes: MAX_JSON_BYTES });
      const parsed = r.truncated ? { error: 'output too large' } : parseEvents(r.stdout);
      if (parsed.error) eventsError = parsed.error;
      else { events = parsed.events.reverse(); eventsTotal = parsed.total; } // newest first
    } catch (err) {
      eventsError = err.code === 'ETIMEDOUT' ? 'gitguard events timed out' : 'could not read events';
    }
  }
  return { summary, status: c.status || null, events, eventsTotal, eventsError };
}

// ---------------------------------------------------------------------------
// Report generation -> one-time download token
// ---------------------------------------------------------------------------

const reports = new Map(); // token -> { instanceId, buffer, filename, expiresAt }
const generating = new Set();

function pruneReports(now = Date.now()) {
  for (const [t, r] of reports) if (r.expiresAt <= now) reports.delete(t);
  while (reports.size > MAX_STORED_REPORTS) reports.delete(reports.keys().next().value);
}

export function safeFilenamePart(s) {
  return String(s || 'instance').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'instance';
}

export async function generateReport(id, instanceName) {
  if (generating.has(id)) { const e = new Error('A report is already being generated for this instance'); e.statusCode = 409; throw e; }
  generating.add(id);
  // Random name the agent cannot predict (and so cannot pre-plant a symlink at).
  const out = `/tmp/cm-gitguard-report-${crypto.randomUUID()}.html`;
  try {
    const r = await execCapture(id, [GITGUARD_BIN, 'report', '--root', '/workspace', '--output', out, '--json'],
      { timeoutMs: REPORT_TIMEOUT_MS, maxBytes: MAX_JSON_BYTES });
    if (r.exitCode === 126 || r.exitCode === 127) { const e = new Error('GitGuard is not installed in this instance'); e.statusCode = 422; throw e; }
    const result = parseReportResult(r.stdout);
    if (result.error) { const e = new Error(`Report failed: ${result.error}`); e.statusCode = 502; throw e; }

    const file = await execCapture(id, ['cat', '--', out], { timeoutMs: 60_000, maxBytes: MAX_REPORT_BYTES });
    if (file.exitCode !== 0) { const e = new Error('Report file could not be read'); e.statusCode = 502; throw e; }
    if (file.truncated) { const e = new Error('Report is larger than 20 MiB'); e.statusCode = 502; throw e; }

    pruneReports();
    const token = crypto.randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `gitguard-report-${safeFilenamePart(instanceName)}-${stamp}.html`;
    reports.set(token, { instanceId: id, buffer: file.stdout, filename, expiresAt: Date.now() + REPORT_TTL_MS });
    return { token, filename, ...result, bytes: file.stdout.length };
  } finally {
    generating.delete(id);
    execCapture(id, ['rm', '-f', '--', out], { timeoutMs: 30_000, maxBytes: 1024 }).catch(() => {});
  }
}

/** Single use: a token is consumed by its first download. */
export function takeReport(instanceId, token) {
  pruneReports();
  const r = reports.get(token);
  if (!r || r.instanceId !== instanceId) return null;
  reports.delete(token);
  return r;
}

/** Test hook: put a report in the store without a container. */
export function _storeReportForTest(instanceId, buffer, filename) {
  const token = crypto.randomUUID();
  reports.set(token, { instanceId, buffer, filename, expiresAt: Date.now() + REPORT_TTL_MS });
  return token;
}
