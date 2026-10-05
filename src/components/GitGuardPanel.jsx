import { useState, useEffect, useCallback } from 'react';
import { fetchGitGuard, generateGitGuardReport, downloadGitGuardReport } from '../api.js';
import { ShieldIcon } from './GitGuardBadge.jsx';

// GitGuard panel for one instance: status, blocked commits, report download.
// Everything shown here was produced inside the container and is untrusted:
// the server sanitises it (server/gitguard.js) and React renders it as text.
// No value is ever interpolated into HTML, a URL, or a style.

const STATE_STYLE = {
  healthy: 'text-emerald-300 bg-emerald-900/30 border-emerald-800',
  unhealthy: 'text-red-300 bg-red-900/30 border-red-800',
  missing: 'text-red-300 bg-red-900/30 border-red-800',
  unknown: 'text-gray-400 bg-gray-800 border-gray-700',
};
const STATE_TEXT = { healthy: 'Active & healthy', unhealthy: 'Unhealthy', missing: 'Not installed', unknown: 'Unknown' };
const SEV_STYLE = { CRITICAL: 'text-red-300', HIGH: 'text-amber-300', MEDIUM: 'text-yellow-300', LOW: 'text-gray-400', INFO: 'text-gray-500' };
const REASON_TEXT = { findings: 'findings', scanner_failure: 'scanner failure', policy_error: 'policy error', user_blocked: 'blocked by user' };

function shortRepo(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

export default function GitGuardPanel({ instance, isAdmin, onClose, showToast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reporting, setReporting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    fetchGitGuard(instance.id)
      .then(setData)
      .catch((err) => setError(err.message || 'Could not load GitGuard status'))
      .finally(() => setLoading(false));
  }, [instance.id]);

  useEffect(() => { load(); }, [load]);

  const handleReport = async () => {
    setReporting(true);
    try {
      const r = await generateGitGuardReport(instance.id, instance.name);
      await downloadGitGuardReport(instance.id, r.token, r.filename);
      showToast?.(`Report downloaded — ${r.findingsTotal} finding(s) across ${r.repos} repo(s)`, 'success');
    } catch (err) {
      showToast?.(err.message || 'Report failed', 'error');
    } finally {
      setReporting(false);
    }
  };

  const summary = data?.summary;
  const status = data?.status;
  const events = data?.events || [];
  const state = STATE_STYLE[summary?.state] ? summary.state : 'unknown';
  const canReport = isAdmin && instance.state === 'running' && (state === 'healthy' || state === 'unhealthy');

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose} data-testid="gitguard-panel">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between shrink-0 gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-100 flex items-center gap-2 truncate">
              <ShieldIcon className="w-4 h-4 text-gray-400" /> GitGuard — {instance.name}
            </h2>
            {summary?.checkedAt && <p className="text-xs text-gray-500">checked {summary.checkedAt}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleReport}
              disabled={!canReport || reporting}
              className="text-xs px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-gray-800 disabled:text-gray-500 text-white transition-colors"
              title={!isAdmin ? 'Admin only' : canReport ? 'Scan every repo in /workspace and download the HTML report' : 'Needs a running instance with GitGuard'}
            >
              {reporting ? 'Generating…' : 'Download report'}
            </button>
            <button onClick={load} disabled={loading} className="text-xs px-2 py-1.5 rounded-md border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600">Refresh</button>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-200 p-1" aria-label="Close">&times;</button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 p-4 flex flex-col gap-4">
          {loading && <div className="text-sm text-gray-500 text-center py-8">Loading…</div>}
          {!loading && error && (
            <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</div>
          )}

          {!loading && summary && (
            <section className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span data-testid="gitguard-state" className={`px-2 py-1 rounded border font-semibold ${STATE_STYLE[state]}`}>{STATE_TEXT[state]}</span>
                {status?.version && <span className="px-2 py-1 rounded border border-gray-700 text-gray-400">v{status.version}{status.commit ? ` · ${status.commit.slice(0, 8)}` : ''}</span>}
                {status && (
                  <span className={`px-2 py-1 rounded border ${status.policyEnforced ? 'border-emerald-900 text-emerald-400' : 'border-gray-700 text-gray-400'}`}>
                    {status.policyEnforced ? 'enforced policy' : 'workstation mode'}
                  </span>
                )}
                {status && (
                  <span className={`px-2 py-1 rounded border ${status.hooksOwned ? 'border-emerald-900 text-emerald-400' : 'border-red-800 text-red-300'}`} title={status.hooksPath}>
                    hooksPath {status.hooksOwned ? 'owned' : 'NOT owned'}{status.hooksScope ? ` (${status.hooksScope})` : ''}
                  </span>
                )}
                <span className="px-2 py-1 rounded border border-gray-700 text-gray-300">{summary.blocked} blocked commit{summary.blocked === 1 ? '' : 's'}</span>
              </div>
              {summary.reason && state !== 'healthy' && <p className="text-xs text-gray-400">{summary.reason}</p>}

              {status?.problems?.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {status.problems.map((p, i) => (
                    <li key={i} className={`text-xs px-2 py-1 rounded border ${p.severity === 'error' ? 'border-red-800 text-red-300 bg-red-900/20' : 'border-amber-900 text-amber-300'}`}>
                      <span className="font-mono">{p.code}</span> — {p.message}
                    </li>
                  ))}
                </ul>
              )}

              {status?.scanners?.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {status.scanners.map((s) => {
                    const ok = s.present && !s.error;
                    return (
                      <div key={s.name} className={`text-[11px] px-2 py-1 rounded border ${ok ? 'border-gray-800 text-gray-300' : (s.required ? 'border-red-800 text-red-300 bg-red-900/20' : 'border-gray-800 text-gray-500')}`}
                        title={s.error || (s.wired ? 'runs on every commit' : 'installed, not run on commit')}>
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-medium truncate">{s.name}</span>
                          <span>{ok ? '✓' : '✗'}</span>
                        </div>
                        <div className="text-gray-500 truncate">{s.present ? (s.version || '?') : 'missing'}{s.required ? ' · required' : ''}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {!loading && summary && (
            <section>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Blocked commits {data.eventsTotal > events.length ? `(latest ${events.length} of ${data.eventsTotal})` : ''}</h3>
              {data.eventsError && <p className="text-xs text-red-400 mb-2">{data.eventsError}</p>}
              {events.length === 0 && !data.eventsError && <p className="text-sm text-gray-500 py-4 text-center">No blocked commits.</p>}
              {events.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]" data-testid="gitguard-events">
                    <thead>
                      <tr className="text-left text-gray-500 border-b border-gray-800">
                        <th className="py-1 pr-3 font-medium">Time (UTC)</th>
                        <th className="py-1 pr-3 font-medium">Repo</th>
                        <th className="py-1 pr-3 font-medium">Scanner</th>
                        <th className="py-1 pr-3 font-medium">Rule</th>
                        <th className="py-1 font-medium">File</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.flatMap((e) => {
                        const rows = e.findings.length > 0
                          ? e.findings.map((f) => ({ scanner: f.scanner, rule: f.ruleId, file: f.line ? `${f.file}:${f.line}` : f.file, sev: f.severity }))
                          : e.scannerFailures.map((f) => ({ scanner: f.scanner, rule: REASON_TEXT[e.reason], file: f.reason, sev: 'HIGH' }));
                        if (rows.length === 0) rows.push({ scanner: '—', rule: REASON_TEXT[e.reason], file: '', sev: 'INFO' });
                        return rows.map((r, j) => (
                          <tr key={`${e.id}-${j}`} className="border-b border-gray-800/60 align-top">
                            <td className="py-1 pr-3 text-gray-400 whitespace-nowrap">{j === 0 ? e.timestamp.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : ''}</td>
                            <td className="py-1 pr-3 text-gray-300 font-mono" title={e.branch ? `${e.repo} (${e.branch})` : e.repo}>{j === 0 ? shortRepo(e.repo) : ''}</td>
                            <td className="py-1 pr-3 text-gray-300">{r.scanner}</td>
                            <td className={`py-1 pr-3 font-mono ${SEV_STYLE[r.sev] || ''}`}>{r.rule}</td>
                            <td className="py-1 text-gray-400 font-mono break-all">{r.file}</td>
                          </tr>
                        ));
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[10px] text-gray-600 mt-2">Secret values are never recorded or shown — only scanner, rule and location.</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
