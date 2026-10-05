export const config = Object.freeze({
  PORT: parseInt(process.env.PORT || '3002', 10),
  DEV_PORT: parseInt(process.env.DEV_PORT || '3002', 10),
  DATA_DIR: process.env.DATA_DIR || '/data',
  CLAUDE_IMAGE: process.env.CLAUDE_IMAGE || 'claude-workspace:latest',
  CLAUDE_NETWORK: process.env.CLAUDE_NETWORK || 'claude-manager-net',
  // Workspace image build context, bind-mounted into the manager so it can
  // rebuild claude-workspace via the Docker API to pick up the latest Claude Code.
  // Empty disables manager-side rebuilds (build the image with compose instead).
  WORKSPACE_SRC_DIR: process.env.WORKSPACE_SRC_DIR || '',
  // How often to check npm for a newer Claude Code and rebuild (hours, 0 = off)
  IMAGE_UPDATE_INTERVAL_HOURS: parseInt(process.env.IMAGE_UPDATE_INTERVAL_HOURS || '24', 10),
  // Trivy security scans of each instance's /workspace (hours, 0 = off)
  SECURITY_SCAN_INTERVAL_HOURS: parseInt(process.env.SECURITY_SCAN_INTERVAL_HOURS || '24', 10),
  // GitGuard indicator: how often to run `gitguard status --json` in each running
  // instance (docker exec). 0 disables the badge, the panel and the polling.
  GITGUARD_POLL_INTERVAL_SECONDS: parseInt(process.env.GITGUARD_POLL_INTERVAL_SECONDS || '120', 10),
  // Restricted policy the post-image-update connectivity smoke test runs against
  // (runs `claude` through squid to confirm Anthropic is reachable after a Claude
  // Code upgrade). Must be a restricted claude-* policy.
  CONNECTIVITY_CHECK_POLICY: process.env.CONNECTIVITY_CHECK_POLICY || 'claude-github',
  TRIVY_IMAGE: process.env.TRIVY_IMAGE || 'aquasec/trivy:latest',
  // TruffleHog verifies whether found secrets are LIVE (calls the provider).
  // Empty disables the verified-secrets pass.
  TRUFFLEHOG_IMAGE: process.env.TRUFFLEHOG_IMAGE || 'ghcr.io/trufflesecurity/trufflehog:latest',
  INSTANCE_LABEL: process.env.INSTANCE_LABEL || 'claude-manager.managed=true',
  HOST_CLAUDE_DIR: process.env.HOST_CLAUDE_DIR || '/host-claude',
  MAX_INSTANCES: parseInt(process.env.MAX_INSTANCES || '20', 10),
  SHARED_DIR: process.env.SHARED_DIR || '/shared',
  // Host paths to bind-mount into new instances (these must be HOST paths, not manager container paths)
  INSTANCE_SHARED_DIR: process.env.INSTANCE_SHARED_DIR || '',
  INSTANCE_MEMORY_DIR: process.env.INSTANCE_MEMORY_DIR || '',
  INSTANCE_CLAUDE_DIR: process.env.INSTANCE_CLAUDE_DIR || '',
  // Base directory for per-instance Claude project memory (host path)
  // Each instance gets a subdirectory: <base>/<slug>/ mounted as /workspace/.claude
  INSTANCE_MEMORY_BASE_DIR: process.env.INSTANCE_MEMORY_BASE_DIR || '',
  // Logging: pino level (trace|debug|info|warn|error) and the slow-request threshold
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  SLOW_REQUEST_MS: parseInt(process.env.SLOW_REQUEST_MS || '2000', 10),
  // Health monitor interval (seconds, 0 = off): sidecars up, restricted ACLs match container IPs
  HEALTH_CHECK_INTERVAL_SECONDS: parseInt(process.env.HEALTH_CHECK_INTERVAL_SECONDS || '300', 10),
  PROXY_CONTAINER: process.env.PROXY_CONTAINER || 'cm-proxy',
  LITELLM_CONTAINER: process.env.LITELLM_CONTAINER || 'cm-litellm',
  NODE_ENV: process.env.NODE_ENV || 'development',
  // Emergency admin reset token — pass as query param ?reset_token=XXX on /api/auth/register
  // to force-register as admin even when devices already exist. Leave empty to disable.
  ADMIN_RESET_TOKEN: process.env.ADMIN_RESET_TOKEN || '',
  // Network policy defaults
  DEFAULT_NETWORK_POLICY: process.env.DEFAULT_NETWORK_POLICY || 'unrestricted',
  // Host path to workspace/policies/ directory (for bind-mounting into workspace containers)
  POLICIES_HOST_DIR: process.env.POLICIES_HOST_DIR || '',
  // Docker volume name for policies (alternative to POLICIES_HOST_DIR for DinD setups)
  POLICIES_VOLUME: process.env.POLICIES_VOLUME || '',
  // Container-local path where policies are mounted in the manager container
  POLICIES_DIR: process.env.POLICIES_DIR || '/policies',
  // Network proxy (squid)
  PROXY_URL: process.env.PROXY_URL || 'http://cm-proxy:3128',
  PROXY_ACL_DIR: process.env.PROXY_ACL_DIR || '/proxy-acl',
  // Stop instances idle this many days (no Claude activity, no open terminal),
  // after asking Claude to save its memory. 0 = off. Fractions allowed for testing.
  IDLE_STOP_DAYS: parseFloat(process.env.IDLE_STOP_DAYS || '3'),
  // Optional comma-separated instance ids to limit idle stop to (rollout/testing)
  IDLE_STOP_INSTANCE_IDS: (process.env.IDLE_STOP_INSTANCE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  IDLE_CHECK_INTERVAL_SECONDS: parseInt(process.env.IDLE_CHECK_INTERVAL_SECONDS || '300', 10),
  // How long to wait for Claude to finish saving before stopping anyway
  IDLE_SAVE_TIMEOUT_MINUTES: parseFloat(process.env.IDLE_SAVE_TIMEOUT_MINUTES || '15'),
  // 1Password service account token injected into every instance (read-only,
  // vault-scoped). Empty = 1Password not configured.
  OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN || '',
  // LiteLLM proxy
  LITELLM_API_BASE: process.env.LITELLM_API_BASE || '',
  LITELLM_MASTER_KEY: process.env.LITELLM_MASTER_KEY || '',
  LITELLM_DEFAULT_BUDGET: parseFloat(process.env.LITELLM_DEFAULT_BUDGET || '20'),
});
