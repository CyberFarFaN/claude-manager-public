// Shield badge for the GitGuard pre-commit gate inside an instance.
//   green  active and healthy
//   red    GitGuard missing, or unhealthy (a scanner missing/broken, hooks not owned, …)
//   grey   unknown: instance stopped, not checked yet, or not reachable
// The number is how many commits GitGuard has blocked in this instance.
// All text comes from the server's sanitised summary and is rendered as text.

const STYLE = {
  healthy: 'text-emerald-400 border-emerald-800 hover:bg-emerald-900/30',
  unhealthy: 'text-red-300 border-red-800 bg-red-900/30 hover:bg-red-900/50',
  missing: 'text-red-300 border-red-800 bg-red-900/30 hover:bg-red-900/50',
  unknown: 'text-gray-500 border-gray-700 hover:bg-gray-800',
};

const LABEL = {
  healthy: 'GitGuard active',
  unhealthy: 'GitGuard unhealthy',
  missing: 'GitGuard missing',
  unknown: 'GitGuard status unknown',
};

export function ShieldIcon({ className = '' }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 1l5.5 2v4.2c0 3.4-2.3 6.4-5.5 7.3C4.8 13.6 2.5 10.6 2.5 7.2V3L8 1z" />
    </svg>
  );
}

export default function GitGuardBadge({ gitguard, onClick }) {
  if (!gitguard) return null;
  const state = STYLE[gitguard.state] ? gitguard.state : 'unknown';
  const blocked = Number.isInteger(gitguard.blocked) && gitguard.blocked > 0 ? gitguard.blocked : 0;
  const title = [
    LABEL[state],
    gitguard.reason ? `— ${gitguard.reason}` : '',
    blocked ? `· ${blocked} blocked commit${blocked === 1 ? '' : 's'}` : '',
    gitguard.checkedAt ? `· checked ${gitguard.checkedAt}` : '',
    '— click for details',
  ].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="gitguard-badge"
      data-state={state}
      className={`inline-flex items-center gap-0.5 text-[10px] border rounded px-1 py-0.5 transition-colors ${STYLE[state]}`}
      title={title}
      aria-label={title}
    >
      <ShieldIcon />
      {blocked > 0 && <span className="font-semibold tabular-nums">{blocked > 999 ? '999+' : blocked}</span>}
    </button>
  );
}
