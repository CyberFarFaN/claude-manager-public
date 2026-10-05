import * as gitguard from '../gitguard.js';

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * GitGuard panel API. Pull-only: every route runs GitGuard's CLI inside the
 * instance over Docker exec (server/gitguard.js); none accepts data FROM a
 * container. Not auth-exempt — the global device-auth hook covers all of it.
 *
 * `impl` is injectable so the HTTP contract (admin gate, download headers,
 * single-use tokens) can be tested without Docker.
 */
export default async function gitguardRoutes(fastify, opts = {}) {
  const impl = opts.impl || gitguard;

  // Status + recent blocked commits, fresh from the instance
  fastify.get('/api/instances/:id/gitguard', async (request, reply) => {
    if (!impl.gitguardEnabled()) { reply.code(404); return { error: 'GitGuard indicator disabled (GITGUARD_POLL_INTERVAL_SECONDS=0)' }; }
    return impl.getGitGuardDetails(request.params.id);
  });

  // Generate the HTML report inside the instance (admin). The report is NOT
  // returned here — only a one-time download token and sanitised counts.
  fastify.post('/api/instances/:id/gitguard/report', async (request, reply) => {
    if (!request.device?.is_admin) { reply.code(403); return { error: 'Admin only' }; }
    if (!impl.gitguardEnabled()) { reply.code(404); return { error: 'GitGuard indicator disabled' }; }
    try {
      return await impl.generateReport(request.params.id, request.body?.name);
    } catch (err) {
      reply.code(err.statusCode || 500);
      return { error: err.statusCode ? err.message : 'Report generation failed' };
    }
  });

  // Download. The HTML was produced inside a container the agent controls, so
  // it must never render in the manager's origin (an XSS here is root on the
  // host via the Docker socket): forced download, opaque content type, and a
  // sandbox CSP in case anything ever renders it anyway.
  fastify.get('/api/instances/:id/gitguard/report/:token', async (request, reply) => {
    if (!request.device?.is_admin) { reply.code(403); return { error: 'Admin only' }; }
    const { id, token } = request.params;
    if (!TOKEN_RE.test(token)) { reply.code(404); return { error: 'Report not found or expired' }; }
    const r = impl.takeReport(id, token);
    if (!r) { reply.code(404); return { error: 'Report not found or expired' }; }
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${r.filename}"`)
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store');
    return reply.send(r.buffer);
  });
}
