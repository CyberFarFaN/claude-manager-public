# Claude Manager — Developer Context

## What this project is
A Docker container management UI specifically for Claude Code workspace containers.
Runs as a container itself. Manages sibling containers via Docker socket mount.
Includes the workspace Docker image source in workspace/.

## Key files to understand first
- server/docker.js — all Docker Engine API interaction, instance creation with mount logic
- server/routes/instances.js — REST API (incl. POST /:id/event, the auth-exempt endpoint the in-container hook posts to)
- src/components/Dashboard.jsx — main UI entry point
- src/lib/notify.js — desktop/toast/audio notifications + token formatting
- workspace/Dockerfile — the Claude Code workspace image
- workspace/scripts/cm-notify + workspace/config/managed-settings.json — Stop/Notification hook that reports lifecycle events + token usage to the manager
- server/gitguard.js + server/routes/gitguard.js — GitGuard indicator: pulls `gitguard status|events|report --json` over docker exec, sanitises everything (container output is untrusted), report served as a forced download only
- server/workspace-image.js — rebuilds claude-workspace over the Docker API to track latest Claude Code (daily check + manual). Needs ./workspace mounted as /workspace-src (WORKSPACE_SRC_DIR).

## Data architecture
- data/shared/ — files shared across all instances (/shared mount)
- data/claude-home/ — global Claude config + auth (/home/claude/.claude mount)
- data/instance-memory/<slug>/ — per-instance Claude project memory (/workspace/.claude mount)
- Each instance gets its own Docker volume for /workspace (code)
- Auth tokens in data/claude-home/ are .gitignored, everything else is git-tracked

## Environment
- Node.js 22
- Fastify backend
- React 19 + Vite frontend
- dockerode for Docker API
- SQLite (better-sqlite3) for manager metadata
- xterm.js for terminal emulation

## Development
npm run dev    # starts both Vite dev server (5173) and Fastify (3002) concurrently
npm run build  # builds frontend into dist/, then Fastify serves it

## Docker context
The manager container mounts /var/run/docker.sock from the host.
Instance containers are identified by the label: claude-manager.managed=true
Instance metadata (human name, tags, notes) stored in SQLite at /data/manager.db
The workspace image is built from workspace/Dockerfile in this repo.

## Naming conventions
- Docker container names: cm-{slug}-{id}
- Docker volumes: cmv-{slug}-{id}
- Docker network: claude-manager-net
- Instance memory dirs: data/instance-memory/{slug}/

## Do not
- Do not use docker-compose CLI from within the container (no CLI in image)
- Do not store auth tokens in SQLite, use Docker secrets or env vars
- Do not hardcode image names, read from CLAUDE_IMAGE env var
- Do not put customer data in data/shared/ — that's for personal tools/templates only
