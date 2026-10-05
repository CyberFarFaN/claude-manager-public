const BASE = '';

async function request(url, options = {}) {
  const headers = { ...options.headers };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${url}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || body.error || `Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// --- Auth ---

export function registerDevice(token, name) {
  return request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ token, name }),
  });
}

export function fetchAuthStatus() {
  return request('/api/auth/status');
}

export function fetchDevices() {
  return request('/api/auth/devices');
}

export function approveDeviceApi(id) {
  return request(`/api/auth/devices/${id}/approve`, { method: 'POST' });
}

export function revokeDeviceApi(id) {
  return request(`/api/auth/devices/${id}`, { method: 'DELETE' });
}

export function renameDeviceApi(id, name) {
  return request(`/api/auth/devices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

// --- Instances ---

export function fetchInstances() {
  return request('/api/instances');
}

export function fetchInstance(id) {
  return request(`/api/instances/${id}`);
}

export function createInstance(opts) {
  return request('/api/instances', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export function startInstance(id) {
  return request(`/api/instances/${id}/start`, { method: 'POST' });
}

export function stopInstance(id) {
  return request(`/api/instances/${id}/stop`, { method: 'POST' });
}

export function removeInstance(id, removeVolume = false) {
  return request(`/api/instances/${id}?removeVolume=${removeVolume}`, {
    method: 'DELETE',
  });
}

export function updateInstance(id, fields) {
  return request(`/api/instances/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

export function recreateInstance(id, opts) {
  return request(`/api/instances/${id}/recreate`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export function updateClaude(id) {
  return request(`/api/instances/${id}/update-claude`, { method: 'POST' });
}

// --- Workspace image (Claude Code version) ---

export function fetchWorkspaceImage() {
  return request('/api/workspace-image');
}

export function rebuildWorkspaceImage() {
  return request('/api/workspace-image/rebuild', { method: 'POST' });
}

// --- GitGuard (pre-commit gate inside each instance) ---

export function fetchGitGuard(id) {
  return request(`/api/instances/${encodeURIComponent(id)}/gitguard`);
}

export function generateGitGuardReport(id, name) {
  return request(`/api/instances/${encodeURIComponent(id)}/gitguard/report`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

/**
 * Download a generated report. The HTML was produced inside a container, so it
 * is fetched as an opaque blob and saved — never opened in this origin.
 */
export async function downloadGitGuardReport(id, token, filename) {
  const res = await fetch(`/api/instances/${encodeURIComponent(id)}/gitguard/report/${encodeURIComponent(token)}`, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Download failed: ${res.status}`);
  }
  const blob = new Blob([await res.arrayBuffer()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'gitguard-report.html';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

// --- Security scans ---

export function fetchSecurityScan() {
  return request('/api/security-scan');
}

export function runSecurityScan() {
  return request('/api/security-scan/run', { method: 'POST' });
}

export function scanInstanceApi(id) {
  return request(`/api/instances/${id}/scan`, { method: 'POST' });
}

export function fetchInstanceScan(id) {
  return request(`/api/instances/${id}/scan`);
}

// --- Policies ---

export function fetchPolicies() {
  return request('/api/policies');
}

// --- Grants ---

export function fetchGrants(instanceId) {
  return request(`/api/instances/${instanceId}/grants`);
}

export function createGrant(instanceId, { capabilityName, expiryHours }) {
  return request(`/api/instances/${instanceId}/grants`, {
    method: 'POST',
    body: JSON.stringify({ capabilityName, expiryHours }),
  });
}

export function renewGrant(grantId, durationHours = 24) {
  return request(`/api/grants/${grantId}/renew`, {
    method: 'POST',
    body: JSON.stringify({ durationHours }),
  });
}

export function recreateWithoutGrant(grantId) {
  return request(`/api/grants/${grantId}/recreate`, { method: 'POST' });
}

// --- LiteLLM ---

export function fetchLiteLLMStatus() {
  return request('/api/litellm/status');
}

export function fetchLiteLLMModels() {
  return request('/api/litellm/models');
}

export function fetchInstanceLiteLLM(instanceId) {
  return request(`/api/instances/${instanceId}/litellm`);
}

export function rotateLiteLLMKey(instanceId) {
  return request(`/api/instances/${instanceId}/litellm/rotate`, { method: 'POST' });
}

// --- Access Requests ---

export function fetchInstanceAccess(instanceId) {
  return request(`/api/instances/${instanceId}/access`);
}

export function fetchAccessRequests() {
  return request('/api/access-requests');
}

export function approveAccessRequest(requestId, expiryHours = 24) {
  return request(`/api/access-requests/${requestId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ expiryHours }),
  });
}

export function denyAccessRequest(requestId) {
  return request(`/api/access-requests/${requestId}/deny`, { method: 'POST' });
}

// --- System ---

export function fetchSystemInfo() {
  return request('/api/system');
}

export function discoverContainers() {
  return request('/api/instances/discover');
}

export function adoptContainer(dockerId, name) {
  return request('/api/instances/adopt', {
    method: 'POST',
    body: JSON.stringify({ dockerId, name }),
  });
}

export function fetchActivityLog() {
  return request('/api/system/activity');
}

export function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);
  return fetch('/api/shared/upload', {
    method: 'POST',
    body: form,
    credentials: 'include',
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.error || 'Upload failed');
    }
    return res.json();
  });
}
