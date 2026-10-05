import { useState } from 'react';
import StatusBadge from './StatusBadge.jsx';
import GrantBadge from './GrantBadge.jsx';
import GitGuardBadge from './GitGuardBadge.jsx';
import { formatTokens } from '../lib/notify.js';

function timeAgo(unixTimestamp) {
  const seconds = Math.floor(Date.now() / 1000 - unixTimestamp);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const borderColors = {
  running: 'border-l-green-500',
  exited: 'border-l-gray-600',
  created: 'border-l-yellow-500',
  removing: 'border-l-red-500',
  paused: 'border-l-blue-500',
  dead: 'border-l-red-700',
};

export default function InstanceCard({ instance, managed = true, onStart, onStop, onTerminal, onRemove, onRecreate, onUpdateClaude, onAdopt, adopting, onPolicyClick, onGrantClick, onScanClick, onGitGuardClick }) {
  const [stopping, setStopping] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [recreating, setRecreating] = useState(false);
  const [updating, setUpdating] = useState(false);
  const busy = stopping || removing || recreating || updating;

  const handleUpdateClaude = async () => {
    if (!window.confirm('Recreate this instance on the latest Claude Code? Your workspace data is retained.')) return;
    setUpdating(true);
    try { await onUpdateClaude(instance.id); } finally { setUpdating(false); }
  };
  const isRunning = instance.state === 'running';
  const isStopped = instance.state === 'exited' || instance.state === 'created';
  const borderColor = borderColors[instance.state] || 'border-l-gray-600';

  const handleStop = async () => {
    setStopping(true);
    try { await onStop(instance.id); } finally { setStopping(false); }
  };

  const handleRemove = async () => {
    if (!window.confirm(`Remove instance "${instance.name}"? This cannot be undone.`)) return;
    setRemoving(true);
    try { await onRemove(instance.id); } finally { setRemoving(false); }
  };

  return (
    <div className={`animate-card-in bg-gray-900 border border-gray-800 border-l-4 ${borderColor} rounded-lg p-4 flex flex-col gap-3 hover:border-gray-700 hover:shadow-lg hover:shadow-black/20 transition-all`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-100 truncate">{instance.name}</h3>
          <p className="text-xs text-gray-500 truncate mt-0.5" title={instance.image}>
            {instance.image?.split(':')[0]?.split('/').pop() || instance.image}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {managed && (
            <>
              <button
                onClick={async () => {
                  const next = !instance.dockerSocket;
                  const msg = next
                    ? 'Enable Docker socket? Container will be recreated.'
                    : 'Disable Docker socket? Container will be recreated.';
                  if (!window.confirm(msg)) return;
                  setRecreating(true);
                  try { await onRecreate(instance.id, { dockerSocket: next }); } finally { setRecreating(false); }
                }}
                disabled={busy}
                className={`text-[10px] border rounded px-1 py-0.5 transition-colors ${
                  instance.dockerSocket
                    ? 'text-yellow-500 border-yellow-800 hover:bg-yellow-900/30'
                    : 'text-gray-600 border-gray-700 hover:text-gray-400 hover:border-gray-600'
                }`}
                title={instance.dockerSocket ? 'Docker socket enabled — click to disable (recreates container)' : 'Docker socket disabled — click to enable (recreates container)'}
              >
                {recreating ? '...' : 'Docker'}
              </button>
              {instance.networkPolicy && (
                <button
                  onClick={() => onPolicyClick?.({ policy: instance.networkPolicy, instanceId: instance.id })}
                  className={`text-[10px] border rounded px-1 py-0.5 transition-colors ${
                    instance.networkPolicy === 'unrestricted'
                      ? 'text-yellow-500 border-yellow-800 hover:bg-yellow-900/30'
                      : 'text-blue-400 border-blue-800 hover:bg-blue-900/30'
                  }`}
                  title={`Network access: ${instance.networkPolicy} — click for details`}
                >
                  {instance.networkPolicy}{instance.hasCustomHosts ? '++' : ''}
                </button>
              )}
              {instance.grants?.filter((g) => g.active).map((grant) => (
                <GrantBadge
                  key={grant.id}
                  grant={grant}
                  onClick={() => onGrantClick?.(instance.id)}
                />
              ))}
              <GitGuardBadge gitguard={instance.gitguard} onClick={() => onGitGuardClick?.(instance)} />
            </>
          )}
          {!managed && (
            <span className="text-[10px] text-gray-500 border border-gray-700 rounded px-1.5 py-0.5">Unmanaged</span>
          )}
          <StatusBadge state={instance.state} />
        </div>
      </div>

      {/* Meta */}
      <div className="text-xs text-gray-500">
        Created {timeAgo(instance.created)}
        {instance.status && <span className="ml-2 text-gray-600">({instance.status})</span>}
      </div>

      {/* Token / context usage — last reported by the in-container Claude hook */}
      {instance.usage?.contextTokens > 0 && (
        <div
          className="flex items-center gap-1.5 text-[11px] text-gray-400"
          title={`Context: ${instance.usage.contextTokens.toLocaleString()} tokens${instance.usage.model ? ` · ${instance.usage.model}` : ''}${instance.usage.updatedAt ? ` · updated ${instance.usage.updatedAt} UTC` : ''}`}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-emerald-500 shrink-0"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7.5 4a.5.5 0 011 0v4l2.5 1.5a.5.5 0 01-.5.86L7.75 8.7A.5.5 0 017.5 8.3V4z"/></svg>
          <span className="text-emerald-400 font-medium">{formatTokens(instance.usage.contextTokens)}</span>
          <span className="text-gray-600">ctx</span>
          {instance.usage.outputTokens > 0 && (
            <span className="text-gray-600">· {formatTokens(instance.usage.outputTokens)} out</span>
          )}
        </div>
      )}

      {/* Security scan (Trivy) — CRITICAL emphasized */}
      {managed && instance.scan && (
        <button
          onClick={() => onScanClick?.(instance)}
          className={`self-start text-[11px] rounded px-1.5 py-0.5 border transition-colors ${
            (instance.scan.verifiedSecrets > 0 || instance.scan.critical > 0)
              ? 'text-red-300 border-red-800 bg-red-900/30 hover:bg-red-900/50'
              : instance.scan.error
                ? 'text-gray-500 border-gray-700 hover:bg-gray-800'
                : (instance.scan.high > 0)
                  ? 'text-amber-400/80 border-amber-900 hover:bg-amber-900/20'
                  : 'text-emerald-500 border-emerald-900 hover:bg-emerald-900/20'
          }`}
          title={instance.scan.error ? `Scan error: ${instance.scan.error}` : `Trivy scan — click for findings (scanned ${instance.scan.scannedAt} UTC)`}
        >
          {instance.scan.error ? 'scan error'
            : instance.scan.verifiedSecrets > 0 ? `🔑 ${instance.scan.verifiedSecrets} LIVE secret`
            : instance.scan.critical > 0 ? `🛡 ${instance.scan.critical} CRITICAL`
            : instance.scan.high > 0 ? `🛡 ${instance.scan.high} high`
            : '🛡 clean'}
          {instance.scan.verifiedSecrets === 0 && instance.scan.secrets > 0 && <span className="ml-1 text-gray-500">· {instance.scan.secrets} secret?</span>}
        </button>
      )}

      {/* Notes */}
      {instance.notes && (
        <p className="text-xs text-gray-400 line-clamp-2">{instance.notes}</p>
      )}

      {/* Tags */}
      {instance.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {instance.tags.map((tag) => (
            <span key={tag} className="px-1.5 py-0.5 bg-gray-800 text-gray-400 text-xs rounded">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Update Claude — shown when the instance is behind the latest image,
          or when its version is unknown (e.g. created before version tracking) */}
      {managed && (instance.updateAvailable || !instance.claudeVersion) && (
        <button
          onClick={handleUpdateClaude}
          disabled={busy}
          className="text-xs px-3 py-2 rounded-md bg-amber-900/30 border border-amber-800 text-amber-300 hover:bg-amber-900/50 disabled:opacity-50 transition-colors min-h-[36px]"
          title={`Update Claude Code${instance.claudeVersion ? ` from ${instance.claudeVersion}` : ''} — recreates the container, keeps data`}
        >
          {updating ? 'Updating…' : '↑ Update Claude'}
        </button>
      )}

      {/* Actions — larger touch targets for mobile */}
      <div className="flex items-center gap-2 mt-auto pt-2 border-t border-gray-800">
        {managed ? (
          <>
            {isRunning && (
              <>
                <button
                  onClick={() => onTerminal(instance.id)}
                  className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-xs font-medium rounded-md transition-colors min-h-[36px]"
                >
                  Terminal
                </button>
                <button
                  onClick={handleStop}
                  disabled={busy}
                  className="px-3 py-2 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 disabled:bg-gray-800 disabled:text-gray-500 text-gray-200 text-xs font-medium rounded-md transition-colors min-h-[36px]"
                >
                  {stopping ? 'Stopping...' : 'Stop'}
                </button>
              </>
            )}
            {isStopped && (
              <button
                onClick={() => onStart(instance.id)}
                className="flex-1 px-3 py-2 bg-green-600 hover:bg-green-700 active:bg-green-800 text-white text-xs font-medium rounded-md transition-colors min-h-[36px]"
              >
                Start
              </button>
            )}
            <button
              onClick={handleRemove}
              disabled={busy}
              className="px-3 py-2 bg-gray-800 hover:bg-red-900/50 active:bg-red-900/70 disabled:bg-gray-800 disabled:text-gray-500 text-gray-400 hover:text-red-400 text-xs font-medium rounded-md transition-colors min-h-[36px]"
              title="Remove instance"
            >
              {removing ? 'Removing...' : 'Remove'}
            </button>
          </>
        ) : (
          <button
            onClick={() => onAdopt?.(instance)}
            disabled={adopting}
            className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-blue-800 disabled:text-blue-400 text-white text-xs font-medium rounded-md transition-colors min-h-[36px]"
          >
            {adopting ? 'Adopting...' : 'Adopt'}
          </button>
        )}
      </div>
    </div>
  );
}
