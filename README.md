# Claude Manager

A self-hosted Docker container management UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) workspaces with **per-container network policy enforcement** and a **pluggable LLM backend**. Claude Manager runs as a Docker container alongside your Claude Code instances, providing a web dashboard to create, monitor, and access isolated workspace containers through the Docker Engine API.

This repository contains everything needed to run the stack — the manager UI, the workspace image, a squid forward proxy, a LiteLLM router, and an Ollama runtime for local inference.

![Claude Manager Dashboard](docs/screenshot-dashboard.png)

**[Overview](#overview)** · **[Architecture](#architecture)** · **[Network Policy](#network-policy)** · **[LLM Backends](#llm-backends)** · **[Data & Auth](#data--auth)** · **[Terminal](#terminal)** · **[Setup](#setup)**

---

## Overview

### At a Glance

Everything Claude Manager gives the operator, on one page.

![Capabilities](docs/diagrams/capabilities.png)

### Features

**Instance management**
- Create, start, stop, recreate, and remove Claude Code containers from a web UI
- Per-instance choice of network policy and LLM backend at creation time
- Automatic discovery and adoption of existing `claude-*` containers
- Real-time updates via Docker event stream (no polling)

**Network policy enforcement**
- Four shipped policies — `claude-only`, `claude-github`, `claude-full-dev`, `unrestricted`
- Enforced by a sidecar squid forward proxy (`cm-proxy`) with per-container ACLs
- Plus an in-container iptables lock — defence in depth, no proxy bypass
- Access request flow — agents request more access via `cm-access`, admin approves/denies in the UI

**Pluggable LLM backend**
- `claude-max` — direct `api.anthropic.com` (your Claude Max subscription)
- `local-llm` — Qwen3 30B-A3B on a local NVIDIA GPU via Ollama
- `foundry` / `foundry-latest` — Azure AI Foundry GPT-4.1-mini / GPT Latest
- All non-`claude-max` backends go through LiteLLM, which speaks Claude's API on the front and routes to Ollama / Azure on the back

**Shared web terminal**
- Full terminal in the browser via xterm.js v6
- tmux sessions shared across devices — desktop + mobile see the same shell
- Tabbed panel with Windows Terminal-style tab management; reconnect without losing state

**Notifications & usage tracking**
- Each container reports Claude Code lifecycle events to the manager via a baked-in `Stop`/`Notification` hook (`cm-notify`)
- Dashboard raises a desktop notification, in-app toast, and chime when Claude finishes a turn or needs attention — toggle with the bell in the header
- Live per-instance **context / token usage** badge, attributed reliably by the container's own ID (works even though instances share one transcript directory)

**Always-latest Claude Code**
- The manager checks npm daily and rebuilds the workspace image (over the Docker API) whenever a newer Claude Code is published, so **new instances always launch on the latest** — plus a manual "Rebuild" button in the header
- Running instances are left untouched; the header shows the current version and any update, and a per-instance **"Update Claude"** button recreates that instance onto the latest image **while retaining its workspace data**

**GitGuard indicator** (for workspace images with [GitGuard](docs/gitguard-indicator.md) baked in)
- Shield badge per instance: green = gate active and healthy, red = GitGuard missing or unhealthy (e.g. a scanner removed), grey = stopped/unknown; the number is how many commits it has blocked
- Click for the panel: scanners + versions, hooksPath ownership, every blocked commit (time, repo, scanner, rule, file — never the secret), and a downloadable HTML report
- The manager **pulls** with `docker exec gitguard … --json`; containers get no new endpoint, and their output is treated as hostile (see [docs/gitguard-indicator.md](docs/gitguard-indicator.md)). `GITGUARD_POLL_INTERVAL_SECONDS=0` turns it off

**Capability grants**
- Time-bound (default 24 h) grants for `docker_socket` and `network_unrestricted`
- Expired grants auto-stop the container; UI offers renew or recreate-without

**Logging & diagnostics**
- Structured JSON logs (pino, `LOG_LEVEL`); failures, slow calls (`SLOW_REQUEST_MS`) and state changes are logged, successful GET polling only at `debug`
- Docker log rotation on every service and every instance (the manager log once reached 20 GB in a week)
- Container lifecycle logged with exit codes (137 = killed, OOM called out)
- **Health monitor** (`HEALTH_CHECK_INTERVAL_SECONDS`, default 300): warns when `cm-proxy`/`cm-litellm` are down or a restricted instance's squid ACL doesn't match its current IP — logged on change only; `GET /api/system/health[?refresh=1]`
- **Egress denials** — squid denials are attributed to the instance that made them and logged (`module: egress`) + recorded in the activity log; `GET /api/system/egress-denials`
- Access requests from **unrestricted** instances are rejected (409) with an explanation — the 403 came from the site, not a policy

**Remote Control**
- Shared settings enable `remoteControlAtStartup`, so every interactive Claude session appears in the Claude app
- Instance containers use their slug as hostname, so Remote Control session names are recognisable
- **Claude autostarts at boot** in the tmux session the web terminal attaches to, and **resumes the instance's previous session** after a restart/recreate (a `SessionStart` hook records the interactive session id in `/workspace/.cm-last-session` on the instance volume; headless `claude -p` runs are ignored). The web terminal is only needed for re-login or debugging. Disable per instance with `CM_AUTOSTART_CLAUDE=0`.

**Idle stop**
- Instances with no Claude activity (hook events, including Remote Control turns) and no open terminal for `IDLE_STOP_DAYS` (default 3; 0 = off) are stopped, never removed
- Before stopping, the manager types a save-your-memory request into the Claude session and waits for its Stop event (or `IDLE_SAVE_TIMEOUT_MINUTES`, default 15). On the next start, Claude resumes the same session
- `IDLE_STOP_INSTANCE_IDS` limits it to specific instances (rollout/testing)

**Secrets via 1Password**
- The workspace image ships the `op` CLI; set `OP_SERVICE_ACCOUNT_TOKEN` in `.env` (a 1Password service account limited to the shared **Claude** vault) and the manager injects it into every instance, re-injecting it on recreate so rotation reaches them
- A managed `/etc/claude-code/CLAUDE.md` in the image makes the **Claude** vault the one place secrets are exchanged: agents read what the user put there, store any secret they create or receive there (reporting only the item title), and never print or commit values (it also carries the `cm-access` network guidance)
- Instance API responses mask secret-looking env values (`*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`)
- Restricted `claude-*` policies allowlist 1Password (`1password.com`, `1passwordusercontent.com`, `1passwordservices.com`)
- Instances keep no plaintext secrets on disk: local files hold `op://Claude/...` references only

**Timezone sync**
- The manager propagates its `TZ` into every instance it creates/recreates, so in-container logs and timestamps match the operator's wall clock

**Data architecture**
- Per-instance project memory isolated at `/workspace/.claude`
- Shared global Claude config (CLAUDE.md + settings + global memories)
- Per-instance auth — each instance runs its own `claude login` (Max) and `gh auth login`
- Shared storage at `/shared` for cross-instance files and uploads
- `data/` is the git-backed backup for config and memory (`instance-memory/`, `claude-home/CLAUDE.md` + `settings.json`); runtime data, secrets and `shared/` files are ignored

### How It Differs from Native Claude Code

Claude Code (2.1.112) ships with worktrees, auto memory, a reference DevContainer config, and session resume. Those solve isolation for **single-user CLI workflows**. Claude Manager fills a different niche:

| Need | Native Claude Code | Claude Manager |
|---|---|---|
| Multi-container orchestration | None | Yes, from one dashboard |
| Full container isolation | Worktrees (same filesystem) | Separate FS, auth, memory per instance |
| Per-container network policy | None | squid proxy + iptables lock, four shipped policies |
| Pluggable LLM backend | Claude only | Claude / local Qwen3 / Azure AI Foundry per instance |
| Web + mobile access | CLI/IDE only | Shared tmux terminals in browser |
| Cross-instance visibility | None | Single dashboard, live state |
| Custom workspace images | DevContainer reference | Versioned, reproducible |

Native worktrees and auto memory are complementary — they work *inside* each container instance.

---

## Architecture

Six containers, one bridge network. The manager creates and tears down workspace containers as siblings via the Docker socket.

![Architecture](docs/diagrams/architecture.png)

**The stack:**

| Container | Source | Role |
|---|---|---|
| `claude-manager` | `Dockerfile` | Fastify 5 backend + React 19 frontend |
| `cm-proxy` | `proxy/Dockerfile` | squid forward proxy — per-container network ACLs |
| `cm-litellm` | `litellm/Dockerfile` | LiteLLM proxy — Claude API → Ollama / Azure |
| `cm-ollama` | `ollama/ollama` | Qwen3 30B-A3B — CPU by default; GPU via the opt-in [`docker-compose.gpu.yml`](docker-compose.gpu.yml) overlay |
| `cm-litellm-db` | `postgres:16` | PostgreSQL for LiteLLM virtual-key state |
| `cm-instance-*` | `workspace/Dockerfile` | Per-project workspace containers |

**Key design decisions:**

- **Docker as source of truth** — container state from the Docker API; SQLite stores supplemental metadata, devices, grants, access requests
- **Sibling containers, not nested** — manager talks to `dockerode` over the host socket
- **Cognitive isolation** — per-instance `/workspace` volume + `/workspace/.claude` memory + per-instance auth
- **Defence in depth on network** — squid filters by domain, iptables blocks bypass attempts at the kernel level
- **Pluggable inference** — non-Claude backends speak Claude's API via LiteLLM, so Claude Code works unchanged
- **Git-backed data** — config and memory live in `data/` inside the repo; push to back up, clone to restore

### Deployment Topology

Physical layout on a host — manager + four sidecars + N workspace instances.

![Deployment](docs/diagrams/deployment.png)

### Instance Lifecycle & Real-Time Updates

REST API for instance management with WebSocket-powered live updates from the Docker event stream.

![Request Flow](docs/diagrams/request-flow.png)

**Creating an instance.** Pick a network policy and LLM backend in the modal. The manager applies the proxy env, mints a LiteLLM virtual key (if needed), writes the per-container ACL, and registers any high-risk capability grants.

![New Instance Modal](docs/screenshot-new-instance.png)

**Adopting existing containers.** The manager queries Docker for `claude-*` containers without the `claude-manager.managed=true` label — they appear as "unmanaged" in the grid and can be adopted in place.

---

## Network Policy

Each container runs under one of four policies, enforced by `cm-proxy` (squid) plus an in-container iptables lock.

![Network policy & access requests](docs/diagrams/network-policy.png)

| Policy | Hosts |
|---|---|
| `claude-only` | Anthropic API + statsig + sentry |
| `claude-github` | + GitHub (web / API / objects / raw / gist / ssh) |
| `claude-full-dev` | + npm, yarn, PyPI, files.pythonhosted.org, Cargo, Docker Hub |
| `unrestricted` | No filtering — covered by a 24 h capability grant |

For restricted policies, the manager injects `HTTPS_PROXY`/`HTTP_PROXY` env into the container *and* runs an entrypoint script that locks outbound traffic with iptables. The proxy reads per-container ACL files generated by the manager and reloads via inotify within ~1 second of any change.

**Agents can request more access.** Inside a restricted container:

```bash
cm-access --list                                    # show policies
cm-access --request --policy claude-github --reason "Need to clone"
cm-access --request --hosts "api.example.com" --reason "Fetch data"
cm-access --poll
```

Admins approve / deny in the dashboard. Policy upgrades recreate the container preserving the volume; extra hosts update the ACL in place without restart.

### Connectivity guard

Restricted policies break silently when Anthropic's endpoints drift and an allowlist goes stale — e.g. Claude Code v2.1.x moved to `platform.claude.com`, which old allowlists didn't include, so squid 403'd it and every restricted instance showed `Failed to connect … ERR_BAD_REQUEST`. Two layers catch this:

- **Policy lint** — every restricted `claude-*` policy must allowlist the hosts in `REQUIRED_CLAUDE_HOSTS` (`shared/constants.js`). Runs at manager startup (logged) and as a test (`tests/11-policy-lint.test.js`), so a dropped host fails CI.
- **Post-update smoke test** — right after the workspace image is rebuilt to a new Claude Code (the moment endpoints can change), the manager spins a throwaway instance on a restricted policy (`CONNECTIVITY_CHECK_POLICY`, default `claude-github`), runs the *real interactive* `claude` through squid, and checks it reaches Anthropic instead of erroring. A failure raises a desktop/toast alert naming the blocked host. Because it runs the real CLI, it catches drift even to endpoints not in the required list. Trigger manually with `POST /api/connectivity-check/run`; last result at `GET /api/connectivity-check`.

> Note: the test uses interactive `claude`, **not** `claude -p` — headless mode skips the `platform.claude.com` startup preflight and would pass even when it's blocked.

---

## LLM Backends

Each instance picks one LLM backend at creation time.

![LLM routing](docs/diagrams/llm-routing.png)

| Backend | Routing |
|---|---|
| `claude-max` | Direct `api.anthropic.com` (`claude login` inside the container) |
| `local-llm` | Qwen3 30B-A3B via Ollama → LiteLLM |
| `foundry` | Azure AI Foundry `gpt-4.1-mini-1` via LiteLLM |
| `foundry-latest` | Azure AI Foundry `gpt-chat-latest` via LiteLLM |

For any backend other than `claude-max`, the manager mints a **per-instance LiteLLM virtual key** with a budget (default $20) and injects `ANTHROPIC_BASE_URL=http://cm-litellm:4000` + `ANTHROPIC_API_KEY=<virtual-key>` so Claude Code speaks Claude's protocol to LiteLLM. LiteLLM's `model_list` aliases Claude model names (`claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, …) to the chosen backend.

The LiteLLM panel on each instance card shows usage and budget.

---

## Data & Auth

### Data Architecture

Per-instance isolation with shared global config. Git-tracked for backup — push to restore.

![Data Architecture](docs/diagrams/data-architecture.png)

```
claude-manager/
├── data/                          <- git-tracked, your backup
│   ├── shared/                    <- /shared in all instances
│   ├── claude-home/               <- /home/claude/.claude (global config + memory, auth gitignored)
│   │   ├── settings.json
│   │   ├── CLAUDE.md              <- global agent instructions (incl. cm-access workflow)
│   │   └── memory/                <- global memories
│   └── instance-memory/           <- per-instance project memory
│       ├── customer-a/            <- /workspace/.claude in customer-a instance
│       └── ...
├── server/                        <- Fastify backend
├── src/                           <- React frontend
├── workspace/
│   └── policies/                  <- YAML — bind-mounted into manager as /policies (RO)
├── proxy/ · litellm/              <- sidecar images
└── workspace/                     <- claude-workspace image source
```

**Isolation model:**
- Each instance has its own workspace volume, project memory, and auth — no cross-contamination
- Global Claude settings, CLAUDE.md, and global memories shared via `data/claude-home/`
- Auth is per-instance: each instance runs its own `claude login` (Max) and `gh auth login`
- `/shared` is explicitly shared for cross-instance files, templates, tools

**Backup:** Push to GitHub. If your machine dies, clone the repo and `docker compose up` — settings and memory are restored. Each instance re-auths on first use.

### Manager Database Schema

`manager.db` (SQLite) holds supplemental metadata: instance metadata, device auth, capability grants, access requests, LiteLLM keys, activity history.

![Schema](docs/diagrams/schema.png)

### Device Authentication

First device auto-approved as admin (TOFU). Subsequent devices require admin approval before accessing the API.

![Auth Flow](docs/diagrams/auth-flow.png)

---

## Terminal

Connect to the same tmux session from multiple devices — desktop and mobile see identical output. Sessions persist across disconnects; reconnecting picks up exactly where you left off.

**Session lifecycle (state machine):**

![Terminal Session Lifecycle](docs/diagrams/terminal-state.png)

**WebSocket protocol (what happens on the wire):**

![Terminal WebSocket Protocol](docs/diagrams/terminal-protocol.png)

---

## Setup

### Prerequisites

- Docker Engine 20.10+ with Compose v2 and socket at `/var/run/docker.sock`
- For the `local-llm` backend: NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/) (Qwen3 30B-A3B needs ~24 GB VRAM)
- For `foundry*`: Azure AI Foundry API keys

### Quick Start

```bash
git clone https://github.com/FrederikLeed/claude-manager-public.git && cd claude-manager-public
cp .env.example .env                               # set absolute host paths, TZ + LiteLLM keys
docker compose --profile build-only build           # build all images
docker compose up -d                                # start the stack
```

Open [http://localhost:3000](http://localhost:3000) — the first browser to load it becomes the admin device. See [`.env.example`](.env.example) for all options and [docs/deployment.md](docs/deployment.md) for the full deployment guide.

**GPU acceleration (local-llm).** The base stack runs Ollama on CPU so it starts on any host. On a machine with an NVIDIA GPU + the Container Toolkit, layer the GPU overlay so `cm-ollama` claims the GPU:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
# or make it the default for this directory:
export COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
```

### Docker Build

```bash
docker compose --profile build-only build   # all buildable images (manager, proxy, litellm, workspace)
docker compose up -d                        # start the stack
```

### Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 |
| Backend | Fastify 5, dockerode, better-sqlite3 |
| Frontend | React 19, Vite, Tailwind CSS 3 |
| Terminal | xterm.js v6 (@xterm/xterm), tmux |
| Workspace | Ubuntu 24.04, Node.js 22, Claude Code, gh CLI, cm-access, cm-notify hook |
| Network | squid forward proxy + iptables lock |
| LLM stack | LiteLLM proxy + Ollama (Qwen3) + Azure AI Foundry |
| Deployment | Docker multi-stage build, Docker Compose v2 |

### Repository Layout

- `server/` — Fastify backend (REST API, WebSocket, Docker management)
- `src/` — React frontend (dashboard, terminal, modals)
- `shared/` — shared constants (network policies, LLM backends)
- `policies/` — network policy YAML files
- `tests/` — integration test suite (Docker-backed)
- `proxy/` — `cm-proxy` image (squid + inotify watcher)
- `litellm/` — `cm-litellm` image (LiteLLM + `config.yaml`)
- `workspace/` — workspace Docker image source (Ubuntu 24.04 + Claude Code + `cm-access` + `cm-notify` hook + managed-settings)
- `data/` — runtime config, global memory, per-instance memory (git-tracked)
- `docs/` — architecture docs, deployment guide, diagrams

<details>
<summary><b>Diagram tooling</b> — every diagram source + render command</summary>

Every diagram is generated from a plain-text source file. Edit the source, re-render, commit both.

| Diagram | Source | Tool | Render |
|---|---|---|---|
| Capabilities | `capabilities.md` | markmap | `markmap capabilities.md --offline --no-open --no-toolbar -o capabilities.html` (PNG via headless screenshot) |
| Architecture | `architecture.dot` | Graphviz | `dot -Tpng architecture.dot -o architecture.png` |
| Deployment | `deployment.py` | mingrammer | `python3 deployment.py` |
| Data architecture | `data-architecture.dot` | Graphviz | `dot -Tpng data-architecture.dot -o data-architecture.png` |
| Schema | `schema.mmd` | Mermaid | `mmdc -i schema.mmd -o schema.png -w 1200 --scale 2` |
| Request flow | `request-flow.mmd` | Mermaid | `mmdc -i request-flow.mmd -o request-flow.png -w 1000 --scale 2` |
| Auth flow | `auth-flow.puml` | PlantUML | `java -jar plantuml.jar -tpng auth-flow.puml` |
| Network policy | `network-policy.puml` | PlantUML | `java -jar plantuml.jar -tpng network-policy.puml` |
| Terminal state | `terminal-state.puml` | PlantUML | `java -jar plantuml.jar -tpng terminal-state.puml` |
| Terminal protocol | `terminal-protocol.puml` | PlantUML | `java -jar plantuml.jar -tpng terminal-protocol.puml` |
| LLM routing | `llm-routing.dot` | Graphviz | `dot -Tpng llm-routing.dot -o llm-routing.png` |

</details>

### Roadmap

Phase 1 (instance management), Phase 2 (observability, shared terminals), and the network-policy work originally planned as Phase 3.5 are all shipped. See [docs/roadmap.md](docs/roadmap.md) and [GitHub issues](https://github.com/FrederikLeed/claude-manager-public/issues).

