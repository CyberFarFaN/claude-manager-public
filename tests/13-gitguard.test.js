/**
 * GitGuard indicator — the manager pulls `gitguard status|events|report --json`
 * from each instance over Docker exec. Everything a container prints is
 * attacker-controlled, so most of this file is about what the sanitisers let
 * through and what the download endpoint refuses to do.
 *
 * Pure unit + route-contract tests (no server, no Docker), plus a live section
 * that only runs under tests/run-all.js against a dev server.
 *
 * Fixtures in tests/fixtures/gitguard/ are REAL output captured from a running
 * workspace instance with GitGuard installed: healthy, then with semgrep
 * removed from the tool path, and its event log after blocked commits.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import Fastify from 'fastify';
import {
  parseStatus, parseEvents, parseReportResult, classifyStatus, safeFilenamePart, MAX_EVENTS,
} from '../server/gitguard.js';
import gitguardRoutes from '../server/routes/gitguard.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/gitguard/${name}`, import.meta.url), 'utf8');
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('GitGuard status parsing (real output)', () => {
  it('healthy instance', () => {
    const s = parseStatus(fixture('status-healthy.json'));
    assert.equal(s.error, undefined);
    assert.equal(s.healthy, true);
    assert.equal(s.policyEnforced, true);
    assert.equal(s.hooksOwned, true);
    assert.ok(s.scanners.length >= 5);
    assert.ok(s.scanners.every((x) => x.present), JSON.stringify(s.scanners));
  });

  it('scanner removed -> unhealthy with the reason', () => {
    const s = parseStatus(fixture('status-scanner-removed.json'));
    assert.equal(s.healthy, false);
    assert.equal(s.scanners.find((x) => x.name === 'semgrep').present, false);
    assert.equal(s.problems[0].code, 'scanner_unavailable');
    assert.match(s.problems[0].message, /semgrep/);
  });

  it('events: blocked commits with scanner, rule, file — newest data intact', () => {
    const e = parseEvents(fixture('events.json'));
    assert.equal(e.error, undefined);
    assert.ok(e.events.length > 0);
    const withFindings = e.events.find((x) => x.findings.length > 0);
    assert.ok(withFindings.timestamp);
    assert.ok(withFindings.repo);
    assert.ok(withFindings.findings[0].scanner);
    assert.ok(withFindings.findings[0].ruleId);
    assert.ok(withFindings.findings[0].file);
  });
});

describe('GitGuard badge classification', () => {
  const healthy = fixture('status-healthy.json');
  const removed = fixture('status-scanner-removed.json');
  const cases = [
    ['exit 0 + healthy', { exitCode: 0, stdout: healthy }, 'healthy'],
    ['exit 2 + unhealthy', { exitCode: 2, stdout: removed }, 'unhealthy'],
    ['exit 0 but healthy:false (inconsistent)', { exitCode: 0, stdout: removed }, 'unhealthy'],
    ['exit 2 but healthy:true (inconsistent)', { exitCode: 2, stdout: healthy }, 'unhealthy'],
    ['binary missing (127)', { exitCode: 127, stdout: '' }, 'missing'],
    ['not executable (126)', { exitCode: 126, stdout: '' }, 'missing'],
    ['garbage output', { exitCode: 0, stdout: '<html>hi</html>' }, 'unhealthy'],
    ['wrong schema', { exitCode: 0, stdout: '{"schema":"gitguard.status/v2","healthy":true}' }, 'unhealthy'],
    ['gitguard.error/v1', { exitCode: 1, stdout: '{"schema":"gitguard.error/v1","error":"boom"}' }, 'unhealthy'],
    ['docker/exec failure', { error: 'could not reach the instance' }, 'unknown'],
  ];
  for (const [name, input, expected] of cases) {
    it(`${name} -> ${expected}`, () => assert.equal(classifyStatus(input).state, expected));
  }
  it('a forged healthy:true with a bad exit code is not green', () => {
    assert.notEqual(classifyStatus({ exitCode: 1, stdout: healthy }).state, 'healthy');
  });
});

describe('GitGuard sanitisers: hostile container output', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const base = JSON.parse(fixture('events.json'));

  it('drops any field outside the allow-list — a finding value never passes', () => {
    const doc = structuredClone(base);
    doc.events[0].findings = [{ scanner: 'gitleaks', rule_id: 'r', file: 'f', line: 1, value: 'ghp_SECRET', secret: 'ghp_SECRET', Match: 'ghp_SECRET' }];
    doc.events[0].secret = 'ghp_SECRET';
    const out = JSON.stringify(parseEvents(JSON.stringify(doc)));
    assert.doesNotMatch(out, /SECRET/);
  });

  it('keeps markup as inert text (escaping is React\'s job) and caps its length', () => {
    const doc = structuredClone(base);
    doc.events[0].repo = evil + 'x'.repeat(10_000);
    const e = parseEvents(JSON.stringify(doc)).events[0];
    assert.equal(e.repo.length, 300);
    assert.ok(e.repo.startsWith(evil));
  });

  it('type confusion becomes safe defaults', () => {
    const s = parseStatus(JSON.stringify({
      schema: 'gitguard.status/v1', healthy: 'true', scanners: 'all good', problems: { a: 1 },
      events: { blocked_total: '9999' }, gitguard: { version: { toString: 1 } }, hooks: [],
    }));
    assert.equal(s.healthy, false, 'only boolean true is healthy');
    assert.deepEqual(s.scanners, []);
    assert.deepEqual(s.problems, []);
    assert.equal(s.blockedTotal, 0);
    assert.equal(s.version, '');
  });

  it('__proto__ keys do not pollute', () => {
    const s = parseStatus('{"schema":"gitguard.status/v1","__proto__":{"polluted":1},"gitguard":{"__proto__":{"x":1}}}');
    assert.equal(({}).polluted, undefined);
    assert.equal(s.polluted, undefined);
  });

  it('caps array sizes', () => {
    const doc = structuredClone(base);
    // Small events, so the 1 MiB output cap is not what stops them.
    doc.events = Array.from({ length: 5000 }, (_, i) => ({ id: `e${i}`, reason: 'findings' }));
    assert.equal(parseEvents(JSON.stringify(doc)).events.length, MAX_EVENTS);
  });

  it('rejects scanner names that are not identifiers', () => {
    const s = parseStatus(JSON.stringify({ schema: 'gitguard.status/v1', scanners: [{ name: evil, present: true }, { name: 'gitleaks', present: true }] }));
    assert.deepEqual(s.scanners.map((x) => x.name), ['gitleaks']);
  });

  it('non-ISO timestamps are dropped, unknown enums fall back', () => {
    const doc = structuredClone(base);
    doc.events[0].timestamp = 'javascript:alert(1)';
    doc.events[0].reason = 'pwned';
    const e = parseEvents(JSON.stringify(doc)).events[0];
    assert.equal(e.timestamp, '');
    assert.equal(e.reason, 'findings');
  });

  it('oversized output is refused, not parsed', () => {
    assert.ok(parseStatus('{"schema":"gitguard.status/v1","x":"' + 'a'.repeat(2_000_000) + '"}').error);
  });

  it('report result keeps counts only', () => {
    const r = parseReportResult(JSON.stringify({
      schema: 'gitguard.report-result/v1', output_path: '/tmp/x', findings_total: 3, repos: [{}, {}],
      by_severity: { CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 0, INFO: 0 }, target: evil,
    }));
    assert.deepEqual(r, { findingsTotal: 3, repos: 2, bySeverity: { critical: 1, high: 2, medium: 0, low: 0, info: 0 } });
  });

  it('download filenames cannot inject header syntax', () => {
    for (const name of ['a"b', 'x\r\nSet-Cookie: y', '../../etc', '']) {
      assert.match(safeFilenamePart(name), /^[A-Za-z0-9._-]+$/);
    }
  });
});

describe('GitGuard routes: HTTP contract', () => {
  let app;
  const tokens = new Map();
  const fake = {
    gitguardEnabled: () => true,
    getGitGuardDetails: async (id) => ({ summary: { state: 'healthy', blocked: 1 }, status: null, events: [], eventsTotal: 0, eventsError: '', id }),
    generateReport: async () => ({ token: '11111111-2222-3333-4444-555555555555', filename: 'gitguard-report-x.html', findingsTotal: 0, repos: 1 }),
    takeReport: (id, token) => {
      const r = tokens.get(token);
      if (!r || r.id !== id) return null;
      tokens.delete(token);
      return r;
    },
  };

  before(async () => {
    app = Fastify();
    app.addHook('onRequest', async (req) => { req.device = { is_admin: req.headers['x-test-admin'] === '1' }; });
    await app.register(gitguardRoutes, { impl: fake });
  });

  it('GET status works for any approved device', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/instances/abc/gitguard' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().summary.state, 'healthy');
  });

  it('report generation is admin only', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/instances/abc/gitguard/report' })).statusCode, 403);
    const ok = await app.inject({ method: 'POST', url: '/api/instances/abc/gitguard/report', headers: { 'x-test-admin': '1' }, payload: {} });
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.json().token);
  });

  it('report download: forced attachment, opaque type, sandbox CSP, nosniff, single use', async () => {
    const token = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    tokens.set(token, { id: 'abc', buffer: Buffer.from('<script>alert(document.cookie)</script>'), filename: 'gitguard-report-abc.html' });
    const url = `/api/instances/abc/gitguard/report/${token}`;
    const r = await app.inject({ method: 'GET', url, headers: { 'x-test-admin': '1' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(r.headers['content-disposition'], 'attachment; filename="gitguard-report-abc.html"');
    assert.match(r.headers['content-security-policy'], /\bsandbox\b/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal((await app.inject({ method: 'GET', url, headers: { 'x-test-admin': '1' } })).statusCode, 404, 'token is single use');
  });

  it('report download: non-admin, other instance, malformed token -> refused', async () => {
    const token = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
    tokens.set(token, { id: 'abc', buffer: Buffer.from('x'), filename: 'r.html' });
    assert.equal((await app.inject({ method: 'GET', url: `/api/instances/abc/gitguard/report/${token}` })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: `/api/instances/other/gitguard/report/${token}`, headers: { 'x-test-admin': '1' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/instances/abc/gitguard/report/..%2F..%2Fetc', headers: { 'x-test-admin': '1' } })).statusCode, 404);
  });

  it('feature off (GITGUARD_POLL_INTERVAL_SECONDS=0) -> 404, no exec', async () => {
    const off = Fastify();
    off.addHook('onRequest', async (req) => { req.device = { is_admin: true }; });
    let called = false;
    await off.register(gitguardRoutes, { impl: { ...fake, gitguardEnabled: () => false, getGitGuardDetails: async () => { called = true; } } });
    assert.equal((await off.inject({ method: 'GET', url: '/api/instances/abc/gitguard' })).statusCode, 404);
    assert.equal(called, false);
  });
});

describe('GitGuard: no container HTML in the manager origin (source guards)', () => {
  it('the UI never uses dangerouslySetInnerHTML for GitGuard data', () => {
    for (const f of ['src/components/GitGuardPanel.jsx', 'src/components/GitGuardBadge.jsx']) {
      assert.doesNotMatch(read(f), /dangerouslySetInnerHTML|innerHTML|srcdoc|<iframe/i, f);
    }
  });
  it('the client saves the report as an opaque blob, never opens it', () => {
    const api = read('src/api.js');
    assert.match(api, /type: 'application\/octet-stream'/);
    assert.match(api, /a\.download = /);
    assert.doesNotMatch(api.slice(api.indexOf('downloadGitGuardReport')), /window\.open|location\.href\s*=/);
  });
  it('the GitGuard routes are not auth-exempt (nothing a container can call)', () => {
    assert.doesNotMatch(read('server/auth.js'), /gitguard/i);
  });
});

// ---- Live: only under tests/run-all.js (dev server + Docker) ----
describe('GitGuard live (dev server)', { skip: !process.env.TEST_DEVICE_TOKEN && 'needs tests/run-all.js + a dev server' }, () => {
  let helpers;
  let instanceId;
  before(async () => {
    helpers = await import('./helpers.js');
    await helpers.authenticate();
    const { instance } = await helpers.createTestInstance('test-gitguard');
    instanceId = instance.id;
    await helpers.waitForState(instanceId, 'running');
  });

  it('GET /api/instances/:id/gitguard returns a sanitised summary', async () => {
    const r = await helpers.api(`/api/instances/${instanceId}/gitguard`);
    assert.equal(r.status, 200);
    assert.ok(['healthy', 'unhealthy', 'missing', 'unknown'].includes(r.json.summary.state), r.text);
    try { await helpers.removeTestInstance(instanceId, true); } catch { /* cleanup */ }
  });
});
