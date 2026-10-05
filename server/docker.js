import Docker from 'dockerode';
import crypto from 'crypto';
import { chownSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { config } from './config.js';
import { getAllInstances } from './db.js';
import { LABELS, CONTAINER_PREFIX, NETWORK_POLICIES } from '../shared/constants.js';
import { moduleLogger } from './logger.js';

// The workspace image runs Claude Code as claude (1001:1001).
const CLAUDE_UID = 1001;
const CLAUDE_GID = 1001;

const log = moduleLogger('docker');

// Rotate instance stdout logs — Docker's json-file default is unbounded.
export const INSTANCE_LOG_CONFIG = { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } };

const MANAGER_URL = 'http://claude-manager:3002';

// Env vars the manager owns and re-injects on every recreate (so rotating a
// secret in .env reaches instances via "Update Claude"/recreate).
const MANAGED_SECRET_PREFIXES = ['OP_SERVICE_ACCOUNT_TOKEN='];
function managedSecretEnv() {
  return config.OP_SERVICE_ACCOUNT_TOKEN ? [`OP_SERVICE_ACCOUNT_TOKEN=${config.OP_SERVICE_ACCOUNT_TOKEN}`] : [];
}

const SECRET_ENV_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
/** Mask values of secret-looking env vars before they leave the manager (API responses). */
export function redactEnv(env = []) {
  return env.map((e) => {
    const i = e.indexOf('=');
    if (i < 0) return e;
    const name = e.slice(0, i);
    return SECRET_ENV_NAME.test(name) && e.length > i + 1 ? `${name}=***` : e;
  });
}

/**
 * Container hostname for an instance: its slug (cm-<slug>-<id> → <slug>).
 * Claude Code names Remote Control sessions after the hostname, so this makes
 * them recognisable in the Claude app instead of a random container id.
 */
export function instanceHostname(containerName, id) {
  const slug = (containerName || '').replace(/^\/?cm-/, '').replace(new RegExp(`-${id}$`), '');
  return (slug || id || 'workspace').slice(0, 63).replace(/-+$/, '') || 'workspace';
}

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Cache for resolved host paths from manager's own mounts
let _selfMounts = null;

/**
 * Resolve a container-internal path to its host source path
 * by inspecting the manager's own bind mounts.
 * e.g. /claude-home → /host/path/to/data/claude-home
 */
export async function resolveHostPath(containerPath) {
  if (!_selfMounts) {
    try {
      const hostname = (await import('os')).hostname();
      const container = docker.getContainer(hostname);
      const inspect = await container.inspect();
      _selfMounts = (inspect.Mounts || []).filter(m => m.Type === 'bind');
    } catch {
      _selfMounts = [];
    }
  }
  const mount = _selfMounts.find(m => m.Destination === containerPath);
  return mount?.Source || null;
}

// Cached bind mount template learned from existing containers
let _mountTemplate = null;

/**
 * Learn bind mounts from an existing container to replicate for new ones.
 * Searches (in order): managed containers, adopted containers (SQLite),
 * and unmanaged claude-workspace containers (same image/name pattern).
 * Skips: /workspace (per-instance), Docker socket, /data (manager-only).
 */
async function learnMountTemplate() {
  if (_mountTemplate) return _mountTemplate;

  const seenIds = new Set();
  const allCandidates = [];

  // 1. Managed containers (labeled)
  try {
    const managed = await docker.listContainers({
      all: true,
      filters: { label: [`${LABELS.MANAGED}=true`] },
    });
    for (const c of managed) {
      seenIds.add(c.Id);
      allCandidates.push(c.Id);
    }
  } catch { /* Docker may be temporarily unavailable */ }

  // 2. Adopted containers from SQLite
  try {
    const dbInstances = getAllInstances();
    for (const dbInst of dbInstances) {
      if (!dbInst.docker_id || seenIds.has(dbInst.docker_id)) continue;
      seenIds.add(dbInst.docker_id);
      allCandidates.push(dbInst.docker_id);
    }
  } catch { /* DB may not be ready */ }

  // 3. Unmanaged claude-workspace containers (same image or name pattern)
  try {
    const claudeImage = config.CLAUDE_IMAGE.split(':')[0];
    const allContainers = await docker.listContainers({ all: true });
    for (const c of allContainers) {
      if (seenIds.has(c.Id)) continue;
      const imageName = c.Image?.split(':')[0] || '';
      const name = c.Names?.[0]?.replace('/', '') || '';
      const isClaudeWorkspace =
        imageName === claudeImage ||
        imageName.endsWith('/claude-workspace') ||
        (name.startsWith('claude-') && name !== 'claude-manager');
      if (isClaudeWorkspace) {
        seenIds.add(c.Id);
        allCandidates.push(c.Id);
      }
    }
  } catch { /* Docker query failed */ }

  // Inspect each candidate and extract shared bind mounts
  for (const id of allCandidates) {
    try {
      const container = docker.getContainer(id);
      const inspect = await container.inspect();
      const containerName = inspect.Name?.replace('/', '') || id.slice(0, 12);
      const mounts = inspect.Mounts || [];

      const sharedBinds = mounts
        .filter((m) => m.Type === 'bind')
        .filter((m) => {
          const dest = m.Destination;
          if (dest === '/workspace') return false;
          if (dest.includes('docker.sock')) return false;
          if (dest === '/data') return false;
          return true;
        })
        .map((m) => `${m.Source}:${m.Destination}${m.RW === false ? ':ro' : ''}`);

      if (sharedBinds.length > 0) {
        _mountTemplate = sharedBinds;
        log.info({ source: containerName, binds: sharedBinds }, 'learned shared bind mounts');
        return _mountTemplate;
      }
    } catch { /* container may be gone */ }
  }

  log.warn({ candidates: allCandidates.length }, 'no shared bind mounts found to learn from');
  return [];
}

/** Clear cached template (call on container changes) */
export function clearMountTemplate() {
  _mountTemplate = null;
}

/**
 * Ensure the manager network exists, creating it if needed.
 */
export async function ensureNetwork() {
  const networks = await docker.listNetworks({
    filters: { name: [config.CLAUDE_NETWORK] },
  });
  const exists = networks.some((n) => n.Name === config.CLAUDE_NETWORK);
  if (!exists) {
    await docker.createNetwork({
      Name: config.CLAUDE_NETWORK,
      Driver: 'bridge',
    });
  }
}

/**
 * List all containers managed by claude-manager.
 * Includes both labeled containers and adopted containers tracked in SQLite.
 */
export async function listManagedContainers() {
  // Get containers with managed label
  const labeledContainers = await docker.listContainers({
    all: true,
    filters: { label: [`${LABELS.MANAGED}=true`] },
  });
  const results = labeledContainers.map(formatContainerInfo);
  const seenDockerIds = new Set(results.map((c) => c.dockerId));

  // Also include adopted containers tracked by docker_id in SQLite
  try {
    const dbInstances = getAllInstances();
    for (const dbInst of dbInstances) {
      if (!dbInst.docker_id || seenDockerIds.has(dbInst.docker_id)) continue;
      try {
        const container = docker.getContainer(dbInst.docker_id);
        const inspect = await container.inspect();
        results.push({
          id: dbInst.id,
          dockerId: inspect.Id,
          name: dbInst.name,
          image: inspect.Config?.Image,
          state: inspect.State?.Status,
          status: inspect.State?.Status === 'running'
            ? `Up ${formatUptime(inspect.State.StartedAt)}`
            : `Exited (${inspect.State?.ExitCode})`,
          created: Math.floor(new Date(inspect.Created).getTime() / 1000),
          ports: [],
          dockerSocket: hasDockerSocket(inspect.Mounts),
        });
      } catch {
        // Container may have been removed externally
      }
    }
  } catch {
    // DB may not be initialized yet during startup
  }

  return results;
}

/**
 * Get detailed info for a single container.
 */
export async function getContainer(id) {
  // Try by manager ID label first
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${LABELS.MANAGED}=true`, `${LABELS.ID}=${id}`] },
  });

  if (containers.length > 0) {
    const container = docker.getContainer(containers[0].Id);
    const inspect = await container.inspect();
    return formatInspectInfo(inspect);
  }

  // Try by SQLite docker_id mapping (adopted containers)
  try {
    const { getInstance } = await import('./db.js');
    const dbInst = getInstance(id);
    if (dbInst?.docker_id) {
      const container = docker.getContainer(dbInst.docker_id);
      const inspect = await container.inspect();
      return formatInspectInfo(inspect);
    }
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }

  // Fall back to name lookup
  const containerName = id.startsWith(CONTAINER_PREFIX) ? id : `${CONTAINER_PREFIX}${id}`;
  try {
    const container = docker.getContainer(containerName);
    const inspect = await container.inspect();
    return formatInspectInfo(inspect);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * Create a new managed container instance.
 */
export async function createInstance({ name, image, env = [], autoStart = false, dockerSocket = false, networkPolicy = 'unrestricted', llmBackend = 'claude-max' }) {
  const id = crypto.randomUUID().slice(0, 8);
  const slug = name
    ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    : id;
  const containerName = `cm-${slug}-${id}`;
  const volumeName = `cmv-${slug}-${id}`;

  // Check instance limit
  const existing = await listManagedContainers();
  if (existing.length >= config.MAX_INSTANCES) {
    const err = new Error(`Maximum instance limit (${config.MAX_INSTANCES}) reached`);
    err.statusCode = 409;
    throw err;
  }

  // Idempotent: check if container with this name exists
  try {
    const existing = docker.getContainer(containerName);
    const inspect = await existing.inspect();
    return formatInspectInfo(inspect);
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }

  // Ensure image is available locally (pull if needed)
  const imageName = image || config.CLAUDE_IMAGE;
  try {
    await ensureImage(imageName);
  } catch (err) {
    const error = new Error(`Failed to pull image "${imageName}": ${err.message}`);
    error.statusCode = err.statusCode || 500;
    throw error;
  }

  // Ensure network exists
  try {
    await ensureNetwork();
  } catch (err) {
    const error = new Error(`Failed to ensure network "${config.CLAUDE_NETWORK}": ${err.message}`);
    error.statusCode = 500;
    throw error;
  }

  // Create the workspace volume
  try {
    await docker.createVolume({ Name: volumeName });
  } catch (err) {
    if (err.statusCode !== 409) { // 409 = volume already exists
      const error = new Error(`Failed to create volume "${volumeName}": ${err.message}`);
      error.statusCode = err.statusCode || 500;
      throw error;
    }
  }

  // Learn bind mounts from existing containers (shared dirs, .claude config, etc.)
  let templateBinds = [];
  try {
    templateBinds = await learnMountTemplate();
  } catch {
    // Fall back to config-based mounts if learning fails
  }

  // Build final bind list: workspace volume + learned template + config overrides
  const binds = [`${volumeName}:/workspace`];

  if (templateBinds.length > 0) {
    // Use learned mounts, but skip any that conflict with explicit config
    const configDests = new Set();
    if (config.INSTANCE_SHARED_DIR) configDests.add('/shared');
    if (config.INSTANCE_MEMORY_DIR) configDests.add('/project-memory');
    if (config.INSTANCE_CLAUDE_DIR) configDests.add('/home/claude/.claude');
    if (config.INSTANCE_MEMORY_BASE_DIR) configDests.add('/workspace/.claude');

    for (const bind of templateBinds) {
      const dest = bind.split(':')[1];
      if (dest === '/workspace') continue; // already added per-instance
      if (configDests.has(dest)) continue; // explicit config takes precedence
      binds.push(bind);
    }
  }

  // Add explicit config-based mounts (override learned ones)
  if (config.INSTANCE_SHARED_DIR) binds.push(`${config.INSTANCE_SHARED_DIR}:/shared`);
  if (config.INSTANCE_MEMORY_DIR) binds.push(`${config.INSTANCE_MEMORY_DIR}:/project-memory`);
  if (config.INSTANCE_CLAUDE_DIR) {
    binds.push(`${config.INSTANCE_CLAUDE_DIR}:/home/claude/.claude`);
  } else if (!binds.some(b => b.includes('/home/claude/.claude'))) {
    // Auto-resolve from manager's own /claude-home mount
    const claudeHomeHost = await resolveHostPath('/claude-home');
    if (claudeHomeHost) binds.push(`${claudeHomeHost}:/home/claude/.claude`);
  }

  // Per-instance project memory: <base>/<slug>/ → /workspace/.claude
  if (config.INSTANCE_MEMORY_BASE_DIR) {
    // Pre-create the directory via the manager's own mount
    // (/instance-memory), owned by the container's claude user: the manager
    // runs as root, and a root-owned mount leaves Claude unable to write its
    // memory there.
    try {
      mkdirSync(`/instance-memory/${slug}/memory`, { recursive: true });
      chownSync(`/instance-memory/${slug}`, CLAUDE_UID, CLAUDE_GID);
      chownSync(`/instance-memory/${slug}/memory`, CLAUDE_UID, CLAUDE_GID);
    } catch (err) {
      log.warn({ err: err.message, slug }, 'could not prepare per-instance memory directory');
    }
    const instanceMemoryPath = `${config.INSTANCE_MEMORY_BASE_DIR}/${slug}`;
    binds.push(`${instanceMemoryPath}:/workspace/.claude`);
    log.info({ containerName, instanceMemoryPath }, 'per-instance memory');
  }

  // Optionally mount Docker socket for container management access
  if (dockerSocket) {
    binds.push('/var/run/docker.sock:/var/run/docker.sock');
  }

  log.info({ containerName, binds, networkPolicy, llmBackend }, 'creating instance');

  // Build environment variables
  const proxyUrl = config.PROXY_URL || 'http://cm-proxy:3128';
  const containerEnv = [
    // Keeps this instance's session transcripts (and Claude's default memory
    // path) out of the shared claude-home project folder.
    `CLAUDE_CODE_PROJECT_DIR_NAME=${slug}`,
    `PROJECT_NAME=${name || 'unnamed'}`,
    `PROJECT_SLUG=${slug}`,
    `CM_INSTANCE_ID=${id}`,
    `CM_MANAGER_URL=${MANAGER_URL}`,
    `CM_NETWORK_POLICY=${networkPolicy || 'unrestricted'}`,
    ...managedSecretEnv(),
    ...env,
  ];

  // Sync timezone from the manager (host) so logs/timestamps match the operator
  if (process.env.TZ) {
    containerEnv.push(`TZ=${process.env.TZ}`);
  }

  // Set proxy env vars for non-unrestricted policies
  if (networkPolicy && networkPolicy !== 'unrestricted') {
    containerEnv.push(
      `HTTP_PROXY=${proxyUrl}`,
      `HTTPS_PROXY=${proxyUrl}`,
      `http_proxy=${proxyUrl}`,
      `https_proxy=${proxyUrl}`,
      // Don't proxy internal Docker network traffic
      `NO_PROXY=localhost,127.0.0.1,claude-manager,cm-proxy,cm-litellm,.claude-manager-net`,
      `no_proxy=localhost,127.0.0.1,claude-manager,cm-proxy,cm-litellm,.claude-manager-net`,
    );
  }

  // LLM backend: route Claude Code through LiteLLM for local/foundry backends
  if (config.LITELLM_API_BASE) {
    containerEnv.push(`LITELLM_API_BASE=${config.LITELLM_API_BASE}`);
  }
  if (llmBackend && llmBackend !== 'claude-max' && config.LITELLM_API_BASE) {
    containerEnv.push(`ANTHROPIC_BASE_URL=${config.LITELLM_API_BASE}`);
    // Use per-backend scoped virtual key for correct model routing
    const backendKeys = {
      'local-llm': process.env.LITELLM_KEY_LOCAL_LLM,
      'foundry': process.env.LITELLM_KEY_FOUNDRY,
      'foundry-latest': process.env.LITELLM_KEY_FOUNDRY_LATEST,
    };
    const apiKey = backendKeys[llmBackend] || config.LITELLM_MASTER_KEY;
    if (apiKey) {
      containerEnv.push(`ANTHROPIC_API_KEY=${apiKey}`);
    }
  }

  // Create the container
  let container;
  try {
    const hostConfig = {
      Binds: binds,
      NetworkMode: config.CLAUDE_NETWORK,
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: INSTANCE_LOG_CONFIG,
    };

    // NET_ADMIN needed for iptables lock (prevents proxy bypass)
    if (networkPolicy && networkPolicy !== 'unrestricted') {
      hostConfig.CapAdd = ['NET_ADMIN'];
    }

    container = await docker.createContainer({
      name: containerName,
      Hostname: instanceHostname(containerName, id),
      Image: imageName,
      Env: containerEnv,
      Labels: {
        [LABELS.MANAGED]: 'true',
        [LABELS.ID]: id,
        [LABELS.NAME]: name,
        [LABELS.NETWORK_POLICY]: networkPolicy || 'unrestricted',
        [LABELS.LLM_BACKEND]: llmBackend || 'claude-max',
      },
      Tty: true,
      OpenStdin: true,
      HostConfig: hostConfig,
    });
  } catch (err) {
    log.error({ err, containerName }, 'failed to create container');
    const error = new Error(`Failed to create container: ${err.message}`);
    error.statusCode = err.statusCode || 500;
    throw error;
  }

  if (autoStart) {
    try {
      await container.start();
    } catch (err) {
      const error = new Error(`Container created but failed to start: ${err.message}`);
      error.statusCode = err.statusCode || 500;
      throw error;
    }
  }

  const inspect = await container.inspect();
  return formatInspectInfo(inspect);
}

/**
 * Start a stopped container.
 */
export async function startInstance(id) {
  const container = await resolveContainer(id);
  try {
    await container.start();
  } catch (err) {
    if (err.statusCode === 304) return; // already running
    throw err;
  }
}

/**
 * Stop a running container.
 */
export async function stopInstance(id, timeoutSeconds = 10) {
  const container = await resolveContainer(id);
  try {
    await container.stop({ t: timeoutSeconds });
  } catch (err) {
    if (err.statusCode === 304) return; // already stopped
    throw err;
  }
}

/**
 * Remove a container and optionally its workspace volume.
 */
export async function removeInstance(id, { removeVolume = false } = {}) {
  const container = await resolveContainer(id);

  // Resolve the workspace volume name from the container's own mounts BEFORE
  // removal. The volume is named cmv-<slug>-<id> at create time, but the slug
  // isn't available here, so read the actual Name off the /workspace mount
  // rather than reconstructing the name (which previously used the wrong
  // prefix and silently orphaned every volume).
  let volumeName = null;
  if (removeVolume) {
    try {
      const inspect = await container.inspect();
      const wsMount = (inspect.Mounts || []).find(
        (m) => m.Type === 'volume' && m.Destination === '/workspace'
      );
      volumeName = wsMount?.Name || null;
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }

  // Stop first if running
  try {
    await container.stop({ t: 5 });
  } catch (err) {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
  }

  await container.remove({ force: true });

  if (removeVolume && volumeName) {
    try {
      const volume = docker.getVolume(volumeName);
      await volume.remove();
    } catch (err) {
      // Volume may not exist, that's fine
      if (err.statusCode !== 404) throw err;
    }
  }
}

/**
 * Execute a command inside a container.
 */
export async function execInContainer(id, cmd) {
  const container = await resolveContainer(id);
  const exec = await container.exec({
    Cmd: Array.isArray(cmd) ? cmd : ['/bin/sh', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Tty: false });
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    // Demux the Docker multiplexed stream (8-byte header per frame)
    docker.modem.demuxStream(stream, {
      write: (chunk) => stdout.push(chunk),
    }, {
      write: (chunk) => stderr.push(chunk),
    });
    stream.on('end', () => {
      const out = Buffer.concat(stdout).toString();
      const err = Buffer.concat(stderr).toString();
      resolve(out || err);
    });
    stream.on('error', reject);
  });
}

/**
 * Execute a command and capture its result with hard limits — for reading
 * output we do not trust (anything a container prints is controlled by the
 * agent inside it). stdout is cut at maxBytes (truncated=true), stderr at 64 KiB,
 * and the call rejects with code ETIMEDOUT after timeoutMs. Docker has no API to
 * kill an exec'd process, so on timeout it keeps running in the container; we
 * only stop waiting for it.
 * @returns {Promise<{exitCode: number|null, stdout: Buffer, stderr: string, truncated: boolean}>}
 */
export async function execCapture(id, cmd, { timeoutMs = 30_000, maxBytes = 1_048_576 } = {}) {
  const container = await resolveContainer(id);
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ Tty: false });
  return new Promise((resolve, reject) => {
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let settled = false;
    const finish = (fn) => { if (settled) return false; settled = true; clearTimeout(timer); return fn(); };
    const timer = setTimeout(() => finish(() => {
      stream.destroy?.();
      const e = new Error(`exec timed out after ${timeoutMs} ms`);
      e.code = 'ETIMEDOUT';
      reject(e);
    }), timeoutMs);
    docker.modem.demuxStream(stream, {
      write: (chunk) => {
        const room = maxBytes - outBytes;
        if (chunk.length > room) {
          truncated = true;
          if (room > 0) { out.push(chunk.subarray(0, room)); outBytes += room; }
        } else {
          out.push(chunk);
          outBytes += chunk.length;
        }
      },
    }, {
      write: (chunk) => { if (errBytes < 65_536) { err.push(chunk); errBytes += chunk.length; } },
    });
    stream.on('end', () => finish(async () => {
      let exitCode = null;
      try { exitCode = (await exec.inspect()).ExitCode; } catch { /* container gone */ }
      resolve({ exitCode, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), truncated });
    }));
    stream.on('error', (e) => finish(() => reject(e)));
  });
}

/**
 * Create a PTY exec session for terminal access.
 * Returns { stream, exec } for bidirectional piping.
 */
export async function createPTY(id, { cols = 80, rows = 24, name } = {}) {
  const container = await resolveContainer(id);

  const promptName = name || id;
  // Use tmux for shared sessions across clients, fall back to bash
  // Separate socket (-L cm) avoids conflicts with user's tmux and its .tmux.conf
  const tmuxCmd = [
    '/bin/sh', '-c',
    'tmux -L cm -f /home/claude/.tmux.conf new-session -A -s main \\; set-option -g window-size latest 2>/dev/null || exec /bin/bash',
  ];
  const exec = await container.exec({
    Cmd: tmuxCmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: [
      'TERM=xterm-256color',
      `PS1=\\[\\e[1;34m\\]${promptName}\\[\\e[0m\\]:\\[\\e[1;32m\\]\\w\\[\\e[0m\\]\\$ `,
    ],
  });

  const stream = await exec.start({
    hijack: true,
    stdin: true,
    Tty: true,
  });

  // Set initial terminal size
  try {
    await exec.resize({ h: rows, w: cols });
  } catch {
    // Resize may fail briefly after start, non-critical
  }

  return { stream, exec };
}

/**
 * Get Docker host system information.
 */
export async function getDockerInfo() {
  const info = await docker.info();
  const version = await docker.version();
  return {
    dockerVersion: version.Version,
    apiVersion: version.ApiVersion,
    os: info.OperatingSystem,
    arch: info.Architecture,
    cpus: info.NCPU,
    totalMemoryGB: Math.round(info.MemTotal / 1073741824 * 10) / 10,
    containers: info.Containers,
    containersRunning: info.ContainersRunning,
    containersStopped: info.ContainersStopped,
  };
}

/**
 * Get Docker event stream filtered to managed containers.
 */
export async function getEventStream() {
  const stream = await docker.getEvents({
    filters: {
      label: [`${LABELS.MANAGED}=true`],
      type: ['container'],
    },
  });
  return stream;
}

/**
 * Discover existing containers that could be adopted.
 * Finds containers matching the claude-workspace image (or name pattern)
 * that don't already have the managed label.
 */
export async function discoverContainers() {
  const allContainers = await docker.listContainers({ all: true });

  // Get already-adopted Docker IDs from SQLite
  let adoptedDockerIds = new Set();
  try {
    const dbInstances = getAllInstances();
    adoptedDockerIds = new Set(dbInstances.filter((i) => i.docker_id).map((i) => i.docker_id));
  } catch {
    // DB may not be ready
  }

  // Match containers by image name or container name pattern
  const claudeImage = config.CLAUDE_IMAGE.split(':')[0]; // strip tag
  const candidates = allContainers.filter((c) => {
    // Skip already-managed containers (labeled)
    if (c.Labels?.[LABELS.MANAGED] === 'true') return false;

    // Skip already-adopted containers (tracked in SQLite)
    if (adoptedDockerIds.has(c.Id)) return false;

    // Match by image name (with or without tag)
    const imageName = c.Image?.split(':')[0] || '';
    if (imageName === claudeImage || imageName.endsWith('/claude-workspace')) return true;

    // Match by container name pattern (claude-*)
    const name = c.Names?.[0]?.replace('/', '') || '';
    if (name.startsWith('claude-') && name !== 'claude-manager') return true;

    return false;
  });

  return candidates.map((c) => ({
    dockerId: c.Id,
    name: c.Names?.[0]?.replace('/', '') || 'unknown',
    image: c.Image,
    state: c.State,
    status: c.Status,
    created: c.Created,
    mounts: c.Mounts || [],
    dockerSocket: hasDockerSocket(c.Mounts),
  }));
}

/**
 * Adopt an existing container by adding managed labels.
 * Cannot modify labels on a running container — we store in SQLite
 * and resolve by Docker ID instead.
 */
export async function adoptContainer(dockerId, { name }) {
  const container = docker.getContainer(dockerId);
  const inspect = await container.inspect();

  // Invalidate mount template cache — adopted container may have useful mounts
  _mountTemplate = null;

  // Generate a manager ID for this container
  const id = crypto.randomUUID().slice(0, 8);

  return {
    id,
    dockerId: inspect.Id,
    name: name || inspect.Name?.replace('/', '') || 'adopted',
    image: inspect.Config?.Image,
    state: inspect.State?.Status,
    status: inspect.State?.Status === 'running'
      ? `Up ${formatUptime(inspect.State.StartedAt)}`
      : `Exited (${inspect.State?.ExitCode})`,
    created: Math.floor(new Date(inspect.Created).getTime() / 1000),
    startedAt: inspect.State?.StartedAt,
    finishedAt: inspect.State?.FinishedAt,
    mounts: inspect.Mounts || [],
  };
}

/**
 * Recreate a container with modified settings (e.g. toggling Docker socket).
 * Preserves: image, env, labels, mounts, network, restart policy.
 * Returns the new container info.
 */
export async function recreateInstance(id, { dockerSocket, networkPolicy, updateImage = false } = {}) {
  const container = await resolveContainer(id);
  const inspect = await container.inspect();

  const wasRunning = inspect.State?.Status === 'running';
  const oldName = inspect.Name?.replace('/', '');
  const oldConfig = inspect.Config || {};
  const oldHostConfig = inspect.HostConfig || {};
  const oldLabels = oldConfig.Labels || {};

  // Optionally move the instance onto the latest workspace image (Update Claude).
  // The workspace volume and all other binds are preserved, so data is retained.
  const newImage = updateImage ? config.CLAUDE_IMAGE : oldConfig.Image;
  if (updateImage && newImage !== oldConfig.Image) {
    await ensureImage(newImage);
  }

  // Resolve current values — use new if provided, else keep old
  const newDockerSocket = dockerSocket ?? hasDockerSocket(inspect.Mounts);
  const newNetworkPolicy = networkPolicy ?? (oldLabels[LABELS.NETWORK_POLICY] || 'unrestricted');

  // Build new bind list: keep existing binds, remove docker socket
  const existingBinds = (oldHostConfig.Binds || []).filter(
    (b) => !b.includes('docker.sock')
  );
  const newBinds = [...existingBinds];
  if (newDockerSocket) {
    newBinds.push('/var/run/docker.sock:/var/run/docker.sock');
  }

  // Update env vars: remove old proxy/policy vars, add new ones
  const proxyUrl = config.PROXY_URL || 'http://cm-proxy:3128';
  const proxyVarPrefixes = ['HTTP_PROXY=', 'HTTPS_PROXY=', 'http_proxy=', 'https_proxy=',
    'NO_PROXY=', 'no_proxy=', 'GLOBAL_AGENT_', 'NETWORK_POLICY=', 'CM_NETWORK_POLICY=',
    // Refresh TZ from the manager on every recreate
    'TZ='];
  // Identity vars are re-asserted too: instances created by older manager
  // versions lack CM_INSTANCE_ID/CM_MANAGER_URL, which disables autostart,
  // cm-notify and cm-access inside them.
  const identityPrefixes = ['CM_INSTANCE_ID=', 'CM_MANAGER_URL='];
  const instanceId = oldLabels[LABELS.ID] || id;
  const newEnv = (oldConfig.Env || []).filter((e) =>
    !proxyVarPrefixes.some(p => e.startsWith(p))
    && !MANAGED_SECRET_PREFIXES.some(p => e.startsWith(p))
    && !identityPrefixes.some(p => e.startsWith(p)));
  newEnv.push(
    `CM_INSTANCE_ID=${instanceId}`, `CM_MANAGER_URL=${MANAGER_URL}`,
    `CM_NETWORK_POLICY=${newNetworkPolicy}`, ...managedSecretEnv(),
  );
  if (process.env.TZ) newEnv.push(`TZ=${process.env.TZ}`);

  if (newNetworkPolicy && newNetworkPolicy !== 'unrestricted') {
    newEnv.push(
      `HTTP_PROXY=${proxyUrl}`, `HTTPS_PROXY=${proxyUrl}`,
      `http_proxy=${proxyUrl}`, `https_proxy=${proxyUrl}`,
      `NO_PROXY=localhost,127.0.0.1,claude-manager,cm-proxy,cm-litellm,.claude-manager-net`,
      `no_proxy=localhost,127.0.0.1,claude-manager,cm-proxy,cm-litellm,.claude-manager-net`,
    );
  }

  // Update labels
  const newLabels = { ...oldLabels, [LABELS.NETWORK_POLICY]: newNetworkPolicy };

  log.info({ instanceId: id, container: oldName, image: newImage, networkPolicy: newNetworkPolicy, updateImage }, 'recreating instance');

  // Create-before-destroy: park the old container under a temporary name,
  // create the replacement, and only remove the old one once the new one is
  // up. On failure the old container is restored (it used to be deleted first,
  // so a failed create lost the instance).
  if (wasRunning) {
    try { await container.stop({ t: 5 }); } catch (err) {
      if (err.statusCode !== 304) throw err;
    }
  }
  const parkedName = `${oldName}-replaced-${Date.now()}`;
  await container.rename({ name: parkedName });

  // Create replacement container with same config
  const hostConfig = {
    Binds: newBinds,
    NetworkMode: oldHostConfig.NetworkMode || config.CLAUDE_NETWORK,
    RestartPolicy: oldHostConfig.RestartPolicy || { Name: 'unless-stopped' },
    LogConfig: INSTANCE_LOG_CONFIG,
  };

  // NET_ADMIN needed for iptables lock (prevents proxy bypass)
  if (newNetworkPolicy && newNetworkPolicy !== 'unrestricted') {
    hostConfig.CapAdd = ['NET_ADMIN'];
  }

  let newContainer = null;
  try {
    newContainer = await docker.createContainer({
      name: oldName,
      Hostname: instanceHostname(oldName, oldLabels[LABELS.ID] || id),
      Image: newImage,
      Env: newEnv,
      Labels: newLabels,
      Tty: oldConfig.Tty ?? true,
      OpenStdin: oldConfig.OpenStdin ?? true,
      HostConfig: hostConfig,
    });
    if (wasRunning) await newContainer.start();
  } catch (err) {
    log.error({ err, instanceId: id, container: oldName }, 'recreate failed; restoring the previous container');
    if (newContainer) await newContainer.remove({ force: true }).catch(() => {});
    await container.rename({ name: oldName }).catch((e) => log.error({ err: e }, 'could not rename the previous container back'));
    if (wasRunning) await container.start().catch((e) => log.error({ err: e }, 'could not restart the previous container'));
    throw err;
  }
  await container.remove({ force: true });

  const newInspect = await newContainer.inspect();
  return formatInspectInfo(newInspect);
}

// --- Internal helpers ---

/**
 * Check if an image exists locally, pull it if not.
 */
async function ensureImage(imageName) {
  try {
    const img = docker.getImage(imageName);
    await img.inspect();
    // Image exists locally
  } catch (err) {
    if (err.statusCode === 404) {
      // Pull the image
      const stream = await docker.pull(imageName);
      // Wait for pull to complete
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      throw err;
    }
  }
}

async function resolveContainer(id) {
  // Try by label first
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${LABELS.MANAGED}=true`, `${LABELS.ID}=${id}`] },
  });

  if (containers.length > 0) {
    return docker.getContainer(containers[0].Id);
  }

  // Try by SQLite docker_id mapping (adopted containers)
  try {
    const { getInstance } = await import('./db.js');
    const dbInst = getInstance(id);
    if (dbInst?.docker_id) {
      const container = docker.getContainer(dbInst.docker_id);
      await container.inspect(); // verify it exists
      return container;
    }
  } catch (err) {
    if (err.statusCode === 404) {
      // Docker ID in DB but container gone — fall through
    } else if (err.statusCode) {
      throw err;
    }
    // DB not initialized or other non-Docker error — fall through
  }

  // Try by name
  const containerName = id.startsWith(CONTAINER_PREFIX) ? id : `${CONTAINER_PREFIX}${id}`;
  const container = docker.getContainer(containerName);

  // Verify it exists
  try {
    await container.inspect();
  } catch (err) {
    if (err.statusCode === 404) {
      const error = new Error(`Instance ${id} not found`);
      error.statusCode = 404;
      throw error;
    }
    throw err;
  }

  return container;
}

function hasDockerSocket(mounts) {
  return (mounts || []).some((m) =>
    (m.Destination || m.destination || '') === '/var/run/docker.sock' ||
    (m.Source || m.source || '').includes('docker.sock')
  );
}

function formatContainerInfo(container) {
  const labels = container.Labels || {};
  return {
    id: labels[LABELS.ID] || container.Id.slice(0, 12),
    dockerId: container.Id,
    name: labels[LABELS.NAME] || container.Names?.[0]?.replace('/', '') || 'unknown',
    image: container.Image,
    state: container.State,
    status: container.Status,
    created: container.Created,
    ports: container.Ports || [],
    dockerSocket: hasDockerSocket(container.Mounts),
    networkPolicy: labels[LABELS.NETWORK_POLICY] || 'unrestricted',
    llmBackend: labels[LABELS.LLM_BACKEND] || 'claude-max',
  };
}

function formatInspectInfo(inspect) {
  const labels = inspect.Config?.Labels || {};
  return {
    id: labels[LABELS.ID] || inspect.Id.slice(0, 12),
    dockerId: inspect.Id,
    name: labels[LABELS.NAME] || inspect.Name?.replace('/', '') || 'unknown',
    image: inspect.Config?.Image,
    state: inspect.State?.Status,
    status: inspect.State?.Status === 'running'
      ? `Up ${formatUptime(inspect.State.StartedAt)}`
      : `Exited (${inspect.State?.ExitCode})`,
    created: Math.floor(new Date(inspect.Created).getTime() / 1000),
    startedAt: inspect.State?.StartedAt,
    finishedAt: inspect.State?.FinishedAt,
    env: redactEnv(inspect.Config?.Env || []),
    mounts: inspect.Mounts || [],
    networkSettings: inspect.NetworkSettings || {},
    dockerSocket: hasDockerSocket(inspect.Mounts),
    networkPolicy: labels[LABELS.NETWORK_POLICY] || 'unrestricted',
    llmBackend: labels[LABELS.LLM_BACKEND] || 'claude-max',
  };
}

/**
 * List available network policies from the policies directory.
 */
export function listPolicies() {
  const policiesDir = config.POLICIES_DIR;
  try {
    const files = readdirSync(policiesDir).filter(f => f.endsWith('.yaml'));
    return files.map(f => {
      const content = readFileSync(path.join(policiesDir, f), 'utf8');
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const descMatch = content.match(/^description:\s*(.+)$/m);
      const isUnrestricted = /^unrestricted:\s*true$/m.test(content);

      // Extract allowed hosts
      const hosts = [];
      let inHosts = false;
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'allowed_hosts:') { inHosts = true; continue; }
        if (inHosts) {
          // Comment/blank lines inside the list are allowed (section headings
          // like "# npm"); they used to end the list, so every host after the
          // first comment was silently dropped from the squid ACL.
          if (trimmed === '' || trimmed.startsWith('#')) continue;
          if (!trimmed.startsWith('-')) { inHosts = false; continue; }
          const host = trimmed.replace(/^-\s*/, '').replace(/\s+#.*$/, '').trim();
          if (host) hosts.push(host);
        }
      }

      return {
        id: f.replace('.yaml', ''),
        name: nameMatch?.[1] || f.replace('.yaml', ''),
        description: descMatch?.[1] || '',
        unrestricted: isUnrestricted,
        allowedHosts: hosts,
      };
    });
  } catch {
    return [];
  }
}

function formatUptime(startedAt) {
  const seconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
