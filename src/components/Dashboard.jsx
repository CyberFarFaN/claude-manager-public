import { useState, useEffect, useCallback, useRef } from 'react';
import { useInstances } from '../hooks/useInstances.js';
import { fetchSystemInfo, discoverContainers, adoptContainer, uploadFile, fetchWorkspaceImage, rebuildWorkspaceImage, fetchSecurityScan, runSecurityScan } from '../api.js';
import SecurityScanModal from './SecurityScanModal.jsx';
import GitGuardPanel from './GitGuardPanel.jsx';
import InstanceCard from './InstanceCard.jsx';
import InstanceRow from './InstanceRow.jsx';
import NewInstanceModal from './NewInstanceModal.jsx';
import TerminalPanel from './Terminal.jsx';
import ActivityLog from './ActivityLog.jsx';
import ToastContainer, { showToast } from './Toast.jsx';
import {
  notificationsEnabled, enableNotifications, disableNotifications,
  desktopNotify, playChime,
} from '../lib/notify.js';
import DeviceManager from './DeviceManager.jsx';
import PolicyPreview from './PolicyPreview.jsx';
import GrantActions from './GrantActions.jsx';
import LiteLLMPanel from './LiteLLMPanel.jsx';
import AccessRequests from './AccessRequests.jsx';

let tabCounter = 0;

export default function Dashboard({ isAdmin, deviceId }) {
  const [notifyOn, setNotifyOn] = useState(() => notificationsEnabled());

  // Raise toast + desktop notification + chime when an instance reports that
  // Claude finished a turn or needs attention (via the in-container hook).
  const handleNotify = useCallback((evt) => {
    if (!notificationsEnabled()) return;
    const name = evt.name || 'instance';
    if (evt.event === 'Notification') {
      const body = evt.message || 'Claude needs your attention';
      showToast(`${name}: ${body}`, 'info');
      desktopNotify(`${name} — needs attention`, body, name);
    } else {
      const body = evt.message || 'Claude finished responding';
      showToast(`${name}: finished`, 'success');
      desktopNotify(`${name} — Claude finished`, body, name);
    }
    playChime();
  }, []);

  const toggleNotify = useCallback(async () => {
    if (notificationsEnabled()) {
      disableNotifications();
      setNotifyOn(false);
    } else {
      await enableNotifications();
      setNotifyOn(true);
      showToast('Notifications enabled', 'success');
    }
  }, []);

  const [imageStatus, setImageStatus] = useState(null);
  const [scanStatus, setScanStatus] = useState(null);
  const [scanModalInstance, setScanModalInstance] = useState(null);
  const [gitguardInstance, setGitGuardInstance] = useState(null);

  // Scan WS events: update status; alert ONLY on new CRITICAL (per preference)
  const handleScanEvent = useCallback((evt) => {
    if (evt.status) setScanStatus(evt.status);
    if (evt.alert) {
      const msg = evt.verifiedSecrets > 0
        ? `${evt.verifiedSecrets} LIVE secret${evt.verifiedSecrets === 1 ? '' : 's'}`
        : `${evt.critical} CRITICAL finding${evt.critical === 1 ? '' : 's'}`;
      showToast(`${evt.name}: ${msg}`, 'error', 8000);
      if (notificationsEnabled()) desktopNotify(`${evt.name} — ${msg}`, 'Security scan found new actionable issues', `scan-${evt.instanceId}`);
    }
  }, []);

  const { instances, loading, error, create, start, stop, remove, recreate, updateClaude, refresh } =
    useInstances({ onNotify: handleNotify, onImageStatus: setImageStatus, onScanEvent: handleScanEvent });

  useEffect(() => { fetchSecurityScan().then(setScanStatus).catch(() => {}); }, []);

  const handleRunScan = useCallback(async () => {
    try {
      const s = await runSecurityScan();
      setScanStatus(s);
      showToast('Security scan started…', 'info');
    } catch (err) {
      showToast(err.message || 'Scan failed to start', 'error');
    }
  }, []);

  useEffect(() => {
    fetchWorkspaceImage().then(setImageStatus).catch(() => {});
  }, []);

  const handleRebuildImage = useCallback(async () => {
    if (!window.confirm('Rebuild the workspace image to the latest Claude Code? Running instances are unaffected until you update them individually.')) return;
    try {
      const status = await rebuildWorkspaceImage();
      setImageStatus(status);
      showToast('Rebuilding workspace image…', 'info');
    } catch (err) {
      showToast(err.message || 'Rebuild failed', 'error');
    }
  }, []);

  const wrappedUpdateClaude = useCallback(async (id) => {
    try {
      await updateClaude(id);
      bumpActivity();
      showToast('Instance updated to latest Claude', 'success');
    } catch (err) {
      showToast(err.message || 'Update failed', 'error');
      throw err;
    }
  }, [updateClaude]);
  const [showNewModal, setShowNewModal] = useState(false);
  const [systemInfo, setSystemInfo] = useState(null);
  const [systemOnline, setSystemOnline] = useState(false);
  const [discovered, setDiscovered] = useState([]);
  const [adopting, setAdopting] = useState(new Set());
  const [containersExpanded, setContainersExpanded] = useState(true);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('cm-view') || 'list');
  const [activityRefresh, setActivityRefresh] = useState(0);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [showDevices, setShowDevices] = useState(false);
  const [policyPreview, setPolicyPreview] = useState(null); // {policy, instanceId}
  const [grantInstanceId, setGrantInstanceId] = useState(null);
  const [litellmInstanceId, setLitellmInstanceId] = useState(null);
  const [accessRequestRefresh, setAccessRequestRefresh] = useState(0);
  const fileInputRef = useRef(null);

  // Terminal tabs state
  const [terminalTabs, setTerminalTabs] = useState([]);
  const [activeTerminalTab, setActiveTerminalTab] = useState(null);
  const [terminalHeight, setTerminalHeight] = useState(0);

  useEffect(() => {
    fetchSystemInfo()
      .then((info) => {
        setSystemInfo(info);
        setSystemOnline(true);
      })
      .catch(() => setSystemOnline(false));
  }, []);

  // Discover adoptable containers — only re-check when instance count changes
  const instanceCount = instances.length;
  useEffect(() => {
    if (!systemOnline) return;
    discoverContainers()
      .then(setDiscovered)
      .catch(() => setDiscovered([]));
  }, [systemOnline, instanceCount]);

  const bumpActivity = useCallback(() => setActivityRefresh((n) => n + 1), []);

  const wrappedCreate = useCallback(async (opts) => {
    const result = await create(opts);
    bumpActivity();
    showToast(`Instance "${opts.name}" created`, 'success');
    return result;
  }, [create, bumpActivity]);

  const wrappedStart = useCallback(async (id) => {
    try {
      await start(id);
      bumpActivity();
    } catch (err) {
      showToast(err.message || 'Failed to start', 'error');
      throw err;
    }
  }, [start, bumpActivity]);

  const wrappedStop = useCallback(async (id) => {
    try {
      await stop(id);
      bumpActivity();
    } catch (err) {
      showToast(err.message || 'Failed to stop', 'error');
      throw err;
    }
  }, [stop, bumpActivity]);

  const wrappedRemove = useCallback(async (id, removeVolume) => {
    try {
      await remove(id, removeVolume);
      bumpActivity();
    } catch (err) {
      showToast(err.message || 'Failed to remove', 'error');
      throw err;
    }
  }, [remove, bumpActivity]);

  const wrappedRecreate = useCallback(async (id, opts) => {
    try {
      await recreate(id, opts);
      bumpActivity();
      showToast('Container recreated', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to recreate', 'error');
      throw err;
    }
  }, [recreate, bumpActivity]);

  const handleAdopt = useCallback(async (container) => {
    setAdopting((prev) => new Set(prev).add(container.dockerId));
    try {
      await adoptContainer(container.dockerId, container.name);
      setDiscovered((prev) => prev.filter((c) => c.dockerId !== container.dockerId));
      await refresh();
      bumpActivity();
      showToast(`Adopted "${container.name}"`, 'success');
    } catch (err) {
      showToast(err.message || 'Adopt failed', 'error');
    } finally {
      setAdopting((prev) => {
        const next = new Set(prev);
        next.delete(container.dockerId);
        return next;
      });
    }
  }, [refresh, bumpActivity]);

  const handleTerminal = useCallback((id) => {
    const existing = terminalTabs.find((t) => t.instanceId === id);
    if (existing) {
      setActiveTerminalTab(existing.id);
      return;
    }

    const instance = instances.find((i) => i.id === id);
    if (!instance) return;

    const tabId = `tab-${++tabCounter}`;
    const newTab = {
      id: tabId,
      instanceId: id,
      name: instance.name,
      state: instance.state,
    };

    setTerminalTabs((prev) => [...prev, newTab]);
    setActiveTerminalTab(tabId);
  }, [terminalTabs, instances]);

  const handleCloseTab = useCallback((tabId) => {
    setTerminalTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTerminalTab === tabId && next.length > 0) {
        setActiveTerminalTab(next[next.length - 1].id);
      } else if (next.length === 0) {
        setActiveTerminalTab(null);
      }
      return next;
    });
  }, [activeTerminalTab]);

  const handleCloseAllTabs = useCallback(() => {
    setTerminalTabs([]);
    setActiveTerminalTab(null);
  }, []);

  const handleFileUpload = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploadStatus('uploading');
    try {
      const result = await uploadFile(file);
      const sizeKB = (result.size / 1024).toFixed(1);
      showToast(`Uploaded ${result.filename} (${sizeKB} KB)`, 'success');
    } catch (err) {
      showToast(err.message || 'Upload failed', 'error');
    }
    setUploadStatus(null);
  }, []);

  // Combine managed instances and discovered containers into one list
  const allContainers = [
    ...instances.map((i) => ({ ...i, _managed: true })),
    ...discovered.map((c) => ({
      id: c.dockerId,
      dockerId: c.dockerId,
      name: c.name,
      image: c.image,
      state: c.state,
      status: c.status,
      created: c.created,
      _managed: false,
    })),
  ];

  const totalCount = allContainers.length;

  return (
    <div className="min-h-dvh bg-gray-950" style={{ paddingBottom: terminalHeight > 0 ? terminalHeight + 16 : 0 }}>
      {/* Top bar */}
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-gray-100">Claude Manager</h1>
            <span className={`w-2 h-2 rounded-full shrink-0 ${systemOnline ? 'bg-green-500' : 'bg-red-500'}`} title={systemOnline ? 'Docker connected' : 'Docker unavailable'} />
            {systemInfo && (
              <span className="text-xs text-gray-500 hidden sm:inline">
                {systemInfo.managedInstances}/{systemInfo.maxInstances} instances
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {imageStatus?.currentVersion && (
              <span
                className={`text-[11px] rounded px-2 py-1 hidden sm:inline-flex items-center gap-1.5 border ${
                  imageStatus.building
                    ? 'text-blue-300 border-blue-800 bg-blue-900/20'
                    : imageStatus.updateAvailable
                      ? 'text-amber-300 border-amber-800 bg-amber-900/20'
                      : 'text-gray-400 border-gray-700'
                }`}
                title={imageStatus.building
                  ? 'Rebuilding workspace image…'
                  : imageStatus.updateAvailable
                    ? `New Claude Code ${imageStatus.latestVersion} available (image has ${imageStatus.currentVersion})`
                    : `Workspace image on Claude Code ${imageStatus.currentVersion}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${imageStatus.building ? 'bg-blue-400 animate-pulse' : imageStatus.updateAvailable ? 'bg-amber-400' : 'bg-green-500'}`} />
                Claude {imageStatus.building ? 'building…' : imageStatus.currentVersion}
                {isAdmin && imageStatus.canRebuild && !imageStatus.building && imageStatus.updateAvailable && (
                  <button onClick={handleRebuildImage} className="ml-1 underline hover:text-amber-200">Rebuild</button>
                )}
              </span>
            )}
            <button
              onClick={toggleNotify}
              className={`px-3 py-2 rounded-lg transition-colors text-sm font-medium ${
                notifyOn
                  ? 'bg-blue-900/40 text-blue-300 hover:bg-blue-900/60'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-gray-200'
              }`}
              title={notifyOn ? 'Notifications on — click to mute' : 'Notifications off — click to enable desktop + sound alerts'}
            >
              {notifyOn ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 16a2 2 0 002-2H6a2 2 0 002 2zm6-4V8a6 6 0 00-4-5.66V2a2 2 0 10-4 0v.34A6 6 0 002 8v4l-1.5 1.5V14h15v-.5L14 12z"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M11.5 6.5A3.5 3.5 0 008 3a3.5 3.5 0 00-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4zM6.5 13a1.6 1.6 0 003 0" strokeLinecap="round" strokeLinejoin="round"/><path d="M1.5 1.5l13 13" strokeLinecap="round"/></svg>
              )}
            </button>
            {isAdmin && scanStatus && (
              <button
                onClick={handleRunScan}
                disabled={scanStatus.scanning}
                className="px-3 py-2 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 disabled:opacity-60 text-gray-200 text-sm font-medium rounded-lg transition-colors"
                title={scanStatus.scanning ? `Scanning ${scanStatus.current || ''}…` : (scanStatus.lastRunAt ? `Last scan ${scanStatus.lastRunAt} UTC` : 'Run a Trivy security scan of all instances')}
              >
                <span className="hidden sm:inline">{scanStatus.scanning ? `Scanning${scanStatus.current ? ` ${scanStatus.current}` : ''}…` : '🛡 Scan'}</span>
                <span className="sm:hidden">🛡</span>
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => setShowDevices(true)}
                className="px-3 py-2 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-gray-200 text-sm font-medium rounded-lg transition-colors"
                title="Manage devices"
              >
                <span className="hidden sm:inline">Devices</span>
                <span className="sm:hidden">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 012.5 2h11A1.5 1.5 0 0115 3.5v7a1.5 1.5 0 01-1.5 1.5h-3.25l.5 2h1.25a.75.75 0 010 1.5H4a.75.75 0 010-1.5h1.25l.5-2H2.5A1.5 1.5 0 011 10.5v-7zm2.5-.5a.5.5 0 00-.5.5v7a.5.5 0 00.5.5h9a.5.5 0 00.5-.5v-7a.5.5 0 00-.5-.5h-9z"/></svg>
                </span>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileUpload}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadStatus === 'uploading'}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 disabled:bg-gray-800 disabled:text-gray-500 text-gray-200 text-sm font-medium rounded-lg transition-colors"
              title="Upload to /shared"
            >
              <span className="hidden sm:inline">{uploadStatus === 'uploading' ? 'Uploading...' : 'Upload'}</span>
              <span className="sm:hidden">{uploadStatus === 'uploading' ? '...' : 'Upload'}</span>
            </button>
            <button
              onClick={() => setShowNewModal(true)}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <span className="hidden sm:inline">+ New Instance</span>
              <span className="sm:hidden">+ New</span>
            </button>
          </div>
        </div>
      </header>

      <ToastContainer />

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 py-6 overflow-y-auto">
        {/* Error banner */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-900/20 border border-red-800 rounded-lg text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2.5 bg-gray-900 border border-gray-800 rounded-lg">
                <div className="skeleton w-2 h-2 rounded-full" />
                <div className="skeleton h-4 w-28" />
                <div className="skeleton h-3 w-24 hidden md:block" />
                <div className="flex-1" />
                <div className="skeleton h-5 w-16 rounded-full" />
                <div className="skeleton h-7 w-16 rounded" />
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && totalCount === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="text-gray-600 text-5xl mb-4">{ }</div>
            <h2 className="text-lg font-medium text-gray-400 mb-2">No instances yet</h2>
            <p className="text-sm text-gray-500 mb-6 max-w-md">
              Create your first Claude Code workspace instance to get started.
              Each instance runs in its own isolated Docker container.
            </p>
            <button
              onClick={() => setShowNewModal(true)}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Create First Instance
            </button>
          </div>
        )}

        {/* Access Requests — pending approval */}
        <AccessRequests
          instances={instances}
          refreshTrigger={accessRequestRefresh}
          onResolved={() => { refresh(); bumpActivity(); setAccessRequestRefresh(n => n + 1); }}
        />

        {/* Container list/grid — collapsible with view toggle */}
        {!loading && totalCount > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => setContainersExpanded((v) => !v)}
                className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                <span className={`transition-transform ${containersExpanded ? 'rotate-180' : ''}`}>&#9660;</span>
                <span className="font-medium">
                  Containers ({totalCount})
                  {discovered.length > 0 && (
                    <span className="ml-1 text-gray-600 font-normal">
                      &middot; {discovered.length} unmanaged
                    </span>
                  )}
                </span>
              </button>
              {containersExpanded && (
                <div className="flex items-center gap-0.5 bg-gray-900 border border-gray-800 rounded-md p-0.5">
                  <button
                    onClick={() => { setViewMode('list'); localStorage.setItem('cm-view', 'list'); }}
                    className={`p-1.5 rounded transition-colors ${viewMode === 'list' ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
                    title="List view"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3h10M2 7h10M2 11h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  </button>
                  <button
                    onClick={() => { setViewMode('grid'); localStorage.setItem('cm-view', 'grid'); }}
                    className={`p-1.5 rounded transition-colors ${viewMode === 'grid' ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
                    title="Grid view"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/></svg>
                  </button>
                </div>
              )}
            </div>
            {containersExpanded && viewMode === 'list' && (
              <div className="flex flex-col gap-2">
                {allContainers.map((item) => (
                  <InstanceRow
                    key={item._managed ? item.id : item.dockerId}
                    instance={item}
                    managed={item._managed}
                    onStart={wrappedStart}
                    onStop={wrappedStop}
                    onTerminal={handleTerminal}
                    onRemove={wrappedRemove}
                    onRecreate={wrappedRecreate}
                    onUpdateClaude={wrappedUpdateClaude}
                    onAdopt={handleAdopt}
                    adopting={!item._managed && adopting.has(item.dockerId)}
                    onPolicyClick={setPolicyPreview}
                    onGrantClick={setGrantInstanceId}
                    onScanClick={setScanModalInstance}
                    onGitGuardClick={setGitGuardInstance}
                  />
                ))}
              </div>
            )}
            {containersExpanded && viewMode === 'grid' && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {allContainers.map((item) => (
                  <InstanceCard
                    key={item._managed ? item.id : item.dockerId}
                    instance={item}
                    managed={item._managed}
                    onStart={wrappedStart}
                    onStop={wrappedStop}
                    onTerminal={handleTerminal}
                    onRemove={wrappedRemove}
                    onRecreate={wrappedRecreate}
                    onUpdateClaude={wrappedUpdateClaude}
                    onAdopt={handleAdopt}
                    adopting={!item._managed && adopting.has(item.dockerId)}
                    onPolicyClick={setPolicyPreview}
                    onGrantClick={setGrantInstanceId}
                    onScanClick={setScanModalInstance}
                    onGitGuardClick={setGitGuardInstance}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Activity log */}
        <ActivityLog refreshTrigger={activityRefresh} />
      </main>

      {/* Device Manager Modal */}
      {showDevices && (
        <DeviceManager
          currentDeviceId={deviceId}
          onClose={() => setShowDevices(false)}
        />
      )}

      {/* New Instance Modal */}
      {showNewModal && (
        <NewInstanceModal
          defaultImage={systemInfo?.defaultImage || ''}
          onSubmit={wrappedCreate}
          onClose={() => setShowNewModal(false)}
        />
      )}

      {/* Policy Preview Modal */}
      {policyPreview && (
        <PolicyPreview
          policyName={policyPreview.policy}
          instanceId={policyPreview.instanceId}
          onClose={() => setPolicyPreview(null)}
        />
      )}

      {/* Grant Actions Modal */}
      {grantInstanceId && (() => {
        const inst = instances.find((i) => i.id === grantInstanceId);
        const grants = inst?.grants || [];
        return grants.length > 0 ? (
          <GrantActions
            grants={grants}
            onAction={() => { refresh(); setGrantInstanceId(null); }}
            onClose={() => setGrantInstanceId(null)}
          />
        ) : null;
      })()}

      {/* LiteLLM Panel */}
      {litellmInstanceId && (
        <LiteLLMPanel
          instanceId={litellmInstanceId}
          onClose={() => setLitellmInstanceId(null)}
        />
      )}

      {/* Security scan findings */}
      {scanModalInstance && (
        <SecurityScanModal
          instanceId={scanModalInstance.id}
          instanceName={scanModalInstance.name}
          onClose={() => setScanModalInstance(null)}
        />
      )}

      {/* GitGuard status / blocked commits / report */}
      {gitguardInstance && (
        <GitGuardPanel
          instance={gitguardInstance}
          isAdmin={isAdmin}
          showToast={showToast}
          onClose={() => setGitGuardInstance(null)}
        />
      )}

      {/* Terminal Panel — docked at bottom with tabs */}
      <TerminalPanel
        tabs={terminalTabs}
        activeTabId={activeTerminalTab}
        onActivate={setActiveTerminalTab}
        onClose={handleCloseTab}
        onCloseAll={handleCloseAllTabs}
        onHeightChange={setTerminalHeight}
      />
    </div>
  );
}
