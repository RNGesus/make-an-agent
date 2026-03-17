# Pi Remote Control App Design

Date: 2026-03-16
Status: Approved

## Goal

Build a web-first application that remotely controls `pi-coding-agent` for coding tasks in existing server-local repositories. The system should support multiple providers and models, route simpler work to cheaper models, escalate harder work to stronger models, enforce per-repo security policies, and make it easy to review diffs and create pull requests.

## Product Scope

### In scope for v1

- Web application as the primary control surface.
- Single self-hosted server.
- Existing local repositories registered from a server directory.
- Coding tasks in repositories.
- Per-repo security and autonomy policies.
- Hybrid model routing: rules first, cheap classifier second, escalation when needed.
- Diff review and pull request creation with stored PR links.

### Out of scope for v1

- Chat control surface.
- Remote terminal UI.
- Distributed workers.
- Automatic repository cloning.
- Broad operational automation outside coding repositories.
- Full live terminal-style event streaming.

## High-Level Approach

Build a control plane around `pi-coding-agent` instead of forking pi.

Pi remains the execution engine and provides:

- model and provider support
- sessions
- extensions
- skills
- SDK and RPC integration points

The application adds the product layer that pi does not provide out of the box:

- web UI
- repo registration
- policy enforcement
- task routing
- approval workflow
- diff and PR workflow
- auditability

## Architecture

### Main components

#### Web UI

Minimal operator interface with:

- repo library
- task form
- task history
- approvals inbox
- diff viewer
- branch and commit status
- PR creation action
- PR links

#### Backend API

Owns:

- authentication for the web app
- repo registration
- policy configuration
- task lifecycle
- approval actions
- PR actions

#### Execution layer

Wraps pi using the SDK or RPC and manages:

- task sessions
- model selection
- branch setup
- execution artifacts
- output capture

#### Policy engine

Enforces:

- workspace-root boundaries
- allowed tools
- allowed command patterns
- approval requirements
- per-repo autonomy level

#### Router

Selects the right model and provider based on:

- deterministic intensity signals
- cheap classifier output for ambiguous tasks
- escalation rules

## Repository Model

Repositories are discovered from a configured parent directory such as `/srv/agent-workspaces/`.

Each repository becomes a first-class object with:

- display name
- absolute root path
- default branch
- GitHub remote metadata
- cheap model profile
- strong model profile
- autonomy policy
- tool permissions
- command restrictions

The web app should make it easy to browse and register repositories from that parent folder.

## Security Model

Security rules must live in the control plane, not only in prompts.

### Path boundaries

All tool and file actions run with a declared `workspace_root` and must stay inside it.

Reject:

- `..` traversal above root
- absolute paths outside root
- symlink escapes outside root

### Per-repo autonomy

Each repository can define its own execution policy, for example:

- read-only
- auto-read plus approve writes
- auto-read and tests plus approve edits and commits
- more autonomous mode for trusted repos

### Command controls

Command execution is filtered through per-repo policy.

The system should:

- allow safe read and test commands automatically when policy allows
- pause for approval on write-like or destructive commands
- support risky bash approvals with `once`, `session`, and `global` scopes
- record audit details for policy decisions

## Task Flow

1. User selects a repository in the web UI and submits a task.
2. Backend runs intake classification and policy checks.
3. Router selects cheap or strong model.
4. Safe read-only analysis and safe test commands may auto-run.
5. Writes, commits, PR creation, or risky commands pause for approval depending on repo policy.
6. Risky bash approvals can be granted once, for the current task session, or globally for the repo.
7. Result is stored as compact artifacts for the UI.

## Intensity Scoring And Model Routing

### Default routing philosophy

- Cheap model for read-only questions, repo discovery, summaries, and simple analysis.
- Strong model for planning, edits, debugging, test repair, and ambiguous tasks.

### Deterministic signals

Primary routing uses simple signals such as:

- read-only vs write intent
- likely number of touched files
- test or build scope
- bug, refactor, migration, or failing-test language
- repo-specific complexity hints

### Cheap classifier

Use a cheap classifier only for ambiguous tasks. It should return:

- task category
- intensity score
- confidence
- recommended model tier

### Escalation rules

Escalate to the stronger model when:

- the task expands beyond expected scope
- many files are involved
- tests fail and repair work begins
- the cheap path loops or exceeds its budget
- classifier confidence is low

Routing decisions should be visible in the UI so the user can understand why a model was chosen.

## Git And Pull Request Workflow

Git should be a first-class part of the task lifecycle.

For change tasks, the system should support:

- creating or selecting a working branch
- showing changed files and diff
- optional commit approval
- PR creation
- storing the PR URL on the task

The minimal UI should prioritize diff review and PR creation over full execution streaming.

## Storage Strategy

Use pi-native persistence where it fits best:

- pi session history
- extension runtime state

Use a small application database for control-plane records that need querying across repos and tasks:

- repositories
- policies
- tasks
- approvals
- routing decisions
- branch and commit metadata
- PR URLs and status
- audit records

SQLite is sufficient for v1.

## Recommended Tech Stack

- Backend: Node.js + TypeScript
- Web app: TanStack Start
- App database: SQLite
- Queue: simple in-process job queue in v1
- Execution engine: pi-coding-agent via SDK or RPC

## Implementation Phases

1. Repo registry and per-repo policy.
2. Task intake and intensity routing.
3. Pi execution wrapper.
4. Approval flow and diff capture.
5. Branch, commit, and PR flow.
6. Security hardening and audit logs.
7. Later frontends for chat and remote terminal.

## Key Design Decisions

- Web-first UI, chat and remote terminal later.
- Single self-hosted server in v1.
- Existing local repos only in v1.
- Per-repo policy is required.
- Hard workspace boundaries are required.
- Minimal UI is preferred over full live execution streaming.
- Diffs and PR workflow are first-class features.
- Hybrid routing with rules first and classifier second.
- Use pi persistence for sessions and SQLite for app-level state.
