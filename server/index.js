import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';

import { config } from './config.js';
import { initDb, syncWithDocker, closeDb } from './db.js';
import { ensureNetwork, listManagedContainers } from './docker.js';
import { registerAuthHooks, normalizePath } from './auth.js';
import instanceRoutes, { stopEventStream, broadcast } from './routes/instances.js';
import terminalRoutes, { closeAllSessions, getActiveSessionCount } from './routes/terminal.js';
import systemRoutes from './routes/system.js';
import sharedRoutes from './routes/shared.js';
import authRoutes from './routes/auth.js';
import grantRoutes from './routes/grants.js';
import litellmRoutes from './routes/litellm.js';
import policyRoutes from './routes/policies.js';
import accessRequestRoutes from './routes/access-requests.js';
import workspaceImageRoutes from './routes/workspace-image.js';
import securityScanRoutes from './routes/security-scan.js';
import gitguardRoutes from './routes/gitguard.js';
import connectivityCheckRoutes from './routes/connectivity-check.js';
import { checkExpiredGrants } from './grants.js';
import { syncAllACLs } from './proxy.js';
import { initImageState, checkAndMaybeRebuild, setImageBroadcaster } from './workspace-image.js';
import { scanAll, setScanBroadcaster } from './security-scan.js';
import { lintPolicies, setConnectivityBroadcaster } from './connectivity-check.js';
import { setLogger } from './logger.js';
import { startHealthMonitor, stopHealthMonitor } from './health.js';
import { startProxyLogWatcher, stopProxyLogWatcher } from './proxy-log.js';
import { startIdleStop, stopIdleStop } from './idle-stop.js';
import { startGitGuardPoller, stopGitGuardPoller } from './gitguard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function start() {
  const fastify = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'err.config.headers'],
    },
    // Per-request logging is replaced by the onResponse hook below. The UI polls
    // several endpoints, and logging every hit buried real events (a 7-day log hit 20 GB).
    disableRequestLogging: true,
  });

  // Log what matters: failures, slow calls and state-changing requests.
  // Successful GET polling stays at debug (LOG_LEVEL=debug to see it).
  fastify.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode;
    const ms = Math.round(reply.elapsedTime);
    const entry = { method: request.method, url: request.url, status, ms, ip: request.ip };
    if (status >= 500) request.log.error(entry, 'request failed');
    else if (status >= 400) request.log.warn(entry, 'request rejected');
    else if (ms >= config.SLOW_REQUEST_MS) request.log.warn(entry, 'slow request');
    else if (request.method !== 'GET' && request.method !== 'HEAD') request.log.info(entry, 'request');
    else request.log.debug(entry, 'request');
  });

  setLogger(fastify.log);

  // Register plugins
  await fastify.register(fastifyWebsocket);
  await fastify.register(fastifyCookie);
  await fastify.register(fastifyCors, {
    origin: config.NODE_ENV === 'development' ? true : false,
    credentials: true,
  });

  // Error handler — MUST be set before route registration in Fastify 5
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || error.status || 500;
    fastify.log.error({ err: error, url: request.url }, 'Request error');
    reply.code(statusCode).send({
      error: error.message || 'Internal server error',
    });
  });

  // SPA fallback — serve index.html for non-API routes
  fastify.setNotFoundHandler((request, reply) => {
    if (normalizePath(request.url).startsWith('/api')) {
      fastify.log.warn({ method: request.method, url: request.url }, 'API route not found');
      reply.code(404).send({ error: `Not found: ${request.method} ${request.url}` });
    } else {
      reply.sendFile('index.html');
    }
  });

  // Auth middleware — gates all /api routes except /api/auth/*
  registerAuthHooks(fastify);

  // Serve built frontend in production
  const distPath = path.join(__dirname, '..', 'dist');
  await fastify.register(fastifyStatic, {
    root: distPath,
    prefix: '/',
    wildcard: false,
    decorateReply: true,
  });

  // Register API routes
  await fastify.register(authRoutes);
  await fastify.register(instanceRoutes);
  await fastify.register(terminalRoutes);
  await fastify.register(systemRoutes);
  await fastify.register(sharedRoutes);
  await fastify.register(grantRoutes);
  await fastify.register(litellmRoutes);
  await fastify.register(policyRoutes);
  await fastify.register(accessRequestRoutes);
  await fastify.register(workspaceImageRoutes);
  await fastify.register(securityScanRoutes);
  await fastify.register(gitguardRoutes);
  await fastify.register(connectivityCheckRoutes);

  // Let the workspace-image, scan and connectivity modules push status over the dashboard WS channel
  setImageBroadcaster(broadcast);
  setScanBroadcaster(broadcast);
  setConnectivityBroadcaster(broadcast);

  // Start grant expiry checker (every 60s)
  const grantCheckInterval = setInterval(() => {
    checkExpiredGrants(null, fastify.log);
  }, 60_000);

  // Keep the workspace image current with the latest Claude Code
  let imageUpdateInterval = null;
  if (config.IMAGE_UPDATE_INTERVAL_HOURS > 0 && config.WORKSPACE_SRC_DIR) {
    imageUpdateInterval = setInterval(() => {
      checkAndMaybeRebuild(fastify.log);
    }, config.IMAGE_UPDATE_INTERVAL_HOURS * 3_600_000);
  }

  // Scheduled Trivy security scans of instance workspaces
  let scanInterval = null;
  if (config.SECURITY_SCAN_INTERVAL_HOURS > 0) {
    scanInterval = setInterval(() => {
      scanAll(fastify.log).catch((err) => fastify.log.error({ err }, 'scheduled scan failed'));
    }, config.SECURITY_SCAN_INTERVAL_HOURS * 3_600_000);
  }

  // Graceful shutdown — close terminal sessions, event stream, grant timer, DB
  fastify.addHook('onClose', () => {
    clearInterval(grantCheckInterval);
    if (imageUpdateInterval) clearInterval(imageUpdateInterval);
    if (scanInterval) clearInterval(scanInterval);
    const sessionCount = getActiveSessionCount();
    if (sessionCount > 0) {
      fastify.log.info(`Closing ${sessionCount} active terminal sessions...`);
    }
    closeAllSessions();
    stopEventStream();
    stopHealthMonitor();
    stopProxyLogWatcher();
    stopIdleStop();
    stopGitGuardPoller();
    closeDb();
  });

  // Startup sequence
  try {
    // Initialize database
    initDb();
    fastify.log.info(`Database initialized at ${config.DATA_DIR}/manager.db`);

    // Ensure Docker network exists
    await ensureNetwork();
    fastify.log.info(`Docker network "${config.CLAUDE_NETWORK}" ready`);

    // Sync SQLite with Docker
    const containers = await listManagedContainers();
    syncWithDocker(containers);
    fastify.log.info(`Synced ${containers.length} managed containers`);

    // Sync proxy ACLs for all running containers
    await syncAllACLs();
    fastify.log.info('Proxy ACLs synced');

    // Lint network policies: warn loudly if any restricted claude-* policy is
    // missing a host Claude Code requires (stale allowlist = silent breakage).
    const lint = lintPolicies();
    if (!lint.ok) {
      for (const v of lint.violations) {
        fastify.log.warn(`Policy "${v.policy}" is missing required Claude hosts: ${v.missing.join(', ')} — Claude Code will fail on this policy`);
      }
    } else {
      fastify.log.info('Network policy lint passed — all restricted claude-* policies allowlist required hosts');
    }

    // Determine current/latest Claude Code version, then run a catch-up check
    // (rebuilds in the background only if npm has a newer version).
    await initImageState(fastify.log);
    if (config.WORKSPACE_SRC_DIR) {
      checkAndMaybeRebuild(fastify.log);
    }
  } catch (err) {
    fastify.log.error({ err }, 'Startup initialization failed');
    // Continue anyway — Docker may not be available in dev without socket
  }

  // Background diagnostics: sidecar/ACL health checks + squid denial attribution
  startHealthMonitor();
  startProxyLogWatcher();
  startIdleStop();
  startGitGuardPoller(broadcast);

  fastify.log.debug(`Registered routes:\n${fastify.printRoutes({ commonPrefix: false })}`);

  // Start server
  const port = config.NODE_ENV === 'development' ? config.DEV_PORT : config.PORT;
  await fastify.listen({ port, host: '0.0.0.0' });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
