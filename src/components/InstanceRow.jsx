import { useState } from 'react';
import StatusBadge from './StatusBadge.jsx';
import GrantBadge from './GrantBadge.jsx';
import GitGuardBadge from './GitGuardBadge.jsx';
import { AccessRequestBadge } from './AccessRequests.jsx';
import { formatTokens } from '../lib/notify.js';

function timeAgo(unixTimestamp) {
  const seconds = Math.floor(Date.now() / 1000 - unixTimestamp);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function InstanceRow({ instance, managed = true, onStart, onStop, onTerminal, onRemove, onRecreate, onUpdateClaude, onAdopt, adopting, onPolicyClick, onGrantClick, onScanClick, onGitGuardClick }) {
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
    <div className="animate-card-in bg-gray-900 border border-gray-800 rounded-lg hover:border-gray-700 transition-all">
      {/* Main row */}
      <div className="flex items-center gap-2 sm:gap-3 px-3 py-2.5">
        {/* Status dot */}
        <span className={`w-2 h-2 rounded-full shrink-0 ${
          isRunning ? 'bg-green-500 animate-pulse' :
          instance.state === 'paused' ? 'bg-blue-500' :
          instance.state === 'dead' ? 'bg-red-500' :
          'bg-gray-500'
        }`} />

        {/* Name — takes available space */}
        <span className="text-sm font-medium text-gray-100 truncate flex-1 min-w-0">
          {instance.name}
        </span>

        {/* Badges */}
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
              className={`text-[10px] border rounded px-1 py-0.5 shrink-0 hidden sm:block transition-colors ${
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
                className={`text-[10px] border rounded px-1 py-0.5 shrink-0 hidden sm:block transition-colors ${
                  instance.networkPolicy === 'unrestricted'
                    ? 'text-yellow-500 border-yellow-800 hover:bg-yellow-900/30'
                    : 'text-blue-400 border-blue-800 hover:bg-blue-900/30'
                }`}
                title={`Network access: ${instance.networkPolicy} — click for details`}
              >
                {instance.networkPolicy}{instance.hasCustomHosts ? '++' : ''}
              </button>
            )}
            {instance.llmBackend && instance.llmBackend !== 'claude-max' && (
              <span
                className="text-[10px] border rounded px-1 py-0.5 shrink-0 hidden sm:block text-purple-400 border-purple-800"
                title={`LLM: ${instance.llmBackend}`}
              >
                {instance.llmBackend === 'local-llm' ? 'Local LLM' : instance.llmBackend === 'foundry' ? 'GPT-4.1-mini' : instance.llmBackend === 'foundry-latest' ? 'GPT Latest' : instance.llmBackend}
              </span>
            )}
            {instance.grants?.filter((g) => g.active).map((grant) => (
              <GrantBadge
                key={grant.id}
                grant={grant}
                onClick={() => onGrantClick?.(instance.id)}
              />
            ))}
            <GitGuardBadge gitguard={instance.gitguard} onClick={() => onGitGuardClick?.(instance)} />
            {instance.usage?.contextTokens > 0 && (
              <span
                className="text-[10px] rounded px-1 py-0.5 shrink-0 hidden md:inline-flex items-center gap-1 text-emerald-400 border border-emerald-900"
                title={`Context: ${instance.usage.contextTokens.toLocaleString()} tokens${instance.usage.model ? ` · ${instance.usage.model}` : ''}`}
              >
                {formatTokens(instance.usage.contextTokens)} ctx
              </span>
            )}
            {instance.scan && (instance.scan.verifiedSecrets > 0 || instance.scan.critical > 0) && (
              <button
                onClick={() => onScanClick?.(instance)}
                className="text-[10px] rounded px-1 py-0.5 shrink-0 hidden sm:inline-flex items-center gap-1 text-red-300 border border-red-800 bg-red-900/30 hover:bg-red-900/50"
                title="Security findings — click for details"
              >
                {instance.scan.verifiedSecrets > 0 ? `🔑 ${instance.scan.verifiedSecrets} LIVE` : `🛡 ${instance.scan.critical} CRIT`}
              </button>
            )}
            <AccessRequestBadge count={instance.pendingRequests} />
          </>
        )}

        {/* Image — desktop only */}
        <span className="text-xs text-gray-500 truncate hidden lg:block max-w-[200px]">
          {instance.image?.split(':')[0]?.split('/').pop() || ''}
        </span>

        {/* Age — desktop only */}
        <span className="text-xs text-gray-600 whitespace-nowrap hidden lg:block">
          {timeAgo(instance.created)}
        </span>

        {/* Status badge */}
        <div className="shrink-0">
          <StatusBadge state={instance.state} />
        </div>

        {/* Actions — icon buttons on mobile, text on desktop */}
        <div className="flex items-center gap-1 shrink-0">
          {managed ? (
            <>
              {(instance.updateAvailable || !instance.claudeVersion) && (
                <button
                  onClick={handleUpdateClaude}
                  disabled={busy}
                  className="px-2 py-1.5 bg-amber-900/30 border border-amber-800 text-amber-300 hover:bg-amber-900/50 disabled:opacity-50 text-xs font-medium rounded transition-colors"
                  title={`Update Claude Code${instance.claudeVersion ? ` from ${instance.claudeVersion}` : ' (version unknown)'} — recreates the container, keeps data`}
                >
                  {updating ? '…' : '↑ Update'}
                </button>
              )}
              {isRunning && (
                <>
                  <button
                    onClick={() => onTerminal(instance.id)}
                    className="px-2 py-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-xs font-medium rounded transition-colors"
                    title="Terminal"
                  >
                    <span className="hidden sm:inline">Terminal</span>
                    <span className="sm:hidden">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3l5 4-5 4V3zm6 8h6v1H8v-1z"/></svg>
                    </span>
                  </button>
                  <button
                    onClick={handleStop}
                    disabled={busy}
                    className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 disabled:bg-gray-800 disabled:text-gray-500 text-gray-200 text-xs font-medium rounded transition-colors"
                    title="Stop"
                  >
                    <span className="hidden sm:inline">{stopping ? '...' : 'Stop'}</span>
                    <span className="sm:hidden">
                      {stopping ? '...' : <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>}
                    </span>
                  </button>
                </>
              )}
              {isStopped && (
                <button
                  onClick={() => onStart(instance.id)}
                  className="px-2 py-1.5 bg-green-600 hover:bg-green-700 active:bg-green-800 text-white text-xs font-medium rounded transition-colors"
                  title="Start"
                >
                  <span className="hidden sm:inline">Start</span>
                  <span className="sm:hidden">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6V2z"/></svg>
                  </span>
                </button>
              )}
              <button
                onClick={handleRemove}
                disabled={busy}
                className="px-2 py-1.5 text-gray-500 hover:text-red-400 hover:bg-red-900/30 active:bg-red-900/50 disabled:text-gray-600 text-xs font-medium rounded transition-colors"
                title="Remove"
              >
                <span className="hidden sm:inline">{removing ? '...' : 'Remove'}</span>
                <span className="sm:hidden">
                  {removing ? '...' : <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z"/><path fillRule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 010-2H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM7 2h2v1H7V2z"/></svg>}
                </span>
              </button>
            </>
          ) : (
            <>
              {!managed && (
                <span className="text-[10px] text-gray-500 border border-gray-700 rounded px-1.5 py-0.5 hidden sm:block">
                  Unmanaged
                </span>
              )}
              <button
                onClick={() => onAdopt?.(instance)}
                disabled={adopting}
                className="px-2 py-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-blue-800 disabled:text-blue-400 text-white text-xs font-medium rounded transition-colors"
              >
                {adopting ? '...' : 'Adopt'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
