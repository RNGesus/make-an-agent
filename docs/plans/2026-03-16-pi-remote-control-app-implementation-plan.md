# Pi Remote Control App Implementation Plan

Date: 2026-03-16
Status: Draft

## Objective

Implement the approved MVP for a web-first control plane around `pi-coding-agent` that can:

- register existing server-local repositories
- enforce per-repo security policies
- route tasks between cheap and strong models
- execute coding tasks through pi
- pause for approvals when required
- show diffs
- create pull requests and store PR links

## Delivery Strategy

Build the system in vertical slices so each milestone produces a usable feature.

Recommended order:

1. Repository registry and policy foundation.
2. Task intake and model routing.
3. Pi execution integration.
4. Approval and diff review.
5. Branch, commit, and PR workflow.
6. Security hardening and observability.

## Proposed Application Structure

```text
apps/
  web/                # TanStack Start UI
  server/             # API, queue, orchestration
packages/
  db/                 # SQLite schema and queries
  shared/             # shared types and validation
  pi-runner/          # pi SDK/RPC wrapper
  policy-engine/      # path and permission enforcement
  task-router/        # intensity scoring and model selection
  github/             # git and GitHub helpers
```

This can still live in a single repository even if the first implementation starts flatter.

## Core Domain Model

### Repository

Fields:

- `id`
- `name`
- `root_path`
- `parent_source`
- `default_branch`
- `remote_url`
- `github_owner`
- `github_repo`
- `is_active`
- `created_at`
- `updated_at`

### RepositoryPolicy

Fields:

- `repo_id`
- `autonomy_mode`
- `allowed_root`
- `allow_read`
- `allow_edit`
- `allow_bash`
- `allow_git_write`
- `allow_pr_create`
- `safe_command_patterns`
- `approval_required_for_edit`
- `approval_required_for_commit`
- `approval_required_for_pr`
- `approval_required_for_risky_bash`
- `cheap_provider`
- `cheap_model`
- `strong_provider`
- `strong_model`
- `classifier_provider`
- `classifier_model`
- `max_escalations`
- `max_task_budget_usd`

### Task

Fields:

- `id`
- `repo_id`
- `title`
- `user_prompt`
- `goal_type`
- `status`
- `routing_tier`
- `routing_reason`
- `classifier_score`
- `classifier_confidence`
- `pi_session_id`
- `branch_name`
- `started_at`
- `completed_at`
- `created_at`

### TaskArtifact

Fields:

- `id`
- `task_id`
- `artifact_type`
- `summary`
- `payload_json`
- `created_at`

Examples:

- changed files
- diff summary
- final answer
- PR metadata
- execution notes

### Approval

Fields:

- `id`
- `task_id`
- `approval_type`
- `requested_action`
- `requested_payload_json`
- `status`
- `decided_by`
- `decided_at`
- `created_at`

### AuditEvent

Fields:

- `id`
- `repo_id`
- `task_id`
- `event_type`
- `message`
- `details_json`
- `created_at`

## Milestone 1: Repo Registry And Policy Foundation

### Goals

- Configure a parent directory such as `/srv/agent-workspaces/`.
- Discover candidate repositories from immediate subfolders.
- Register repositories into the application.
- Create and edit per-repo policy.

### Backend work

- Add config for `WORKSPACE_PARENT_DIR`.
- Create repo scan service.
- Create repo registration endpoints.
- Create policy CRUD endpoints.

### UI work

- Repo library page.
- Candidate repo scan/import flow.
- Repo detail page.
- Policy editor page.

### Acceptance criteria

- User can scan the parent directory.
- User can register a repo.
- User can configure autonomy and model profiles per repo.

## Milestone 2: Task Intake And Routing

### Goals

- Submit tasks against a selected repository.
- Compute deterministic intensity score.
- Optionally run a cheap classifier for ambiguous tasks.
- Persist routing decisions.

### Backend work

- Task creation endpoint.
- Deterministic routing engine.
- Classifier adapter.
- Routing decision persistence.

### Routing v1 algorithm

Use rules first:

- `question` or read-only intent -> cheap tier
- `plan`, `implement`, `fix`, `refactor`, `debug` -> strong tier
- mentions of tests, build, migration, many files -> strong tier
- if ambiguous -> run cheap classifier
- if confidence low -> strong tier

### UI work

- New task form.
- Task list.
- Task detail page with routing reason.

### Acceptance criteria

- Every task stores model tier and routing explanation.
- User can see why a task used a cheap or strong model.

## Milestone 3: Pi Execution Wrapper

### Goals

- Run tasks through pi in a controlled way.
- Persist pi session identifiers.
- Capture result summaries and artifacts.

### Integration choice

Prefer the pi SDK if it gives enough lifecycle control. Use RPC if process-level isolation is easier for the first version.

Decision checkpoint:

- choose SDK if in-process orchestration is straightforward
- choose RPC if subprocess boundaries simplify execution control and recovery

### Pi runner responsibilities

- start a task session
- select provider and model
- inject repo-scoped context
- record output summary
- capture changed files and diff after execution
- stop or pause when approval is required

### Acceptance criteria

- The app can execute a simple read-only task against a repo.
- The app can store the final answer and session reference.

## Milestone 4: Policy Enforcement And Approvals

### Goals

- Enforce hard workspace boundaries.
- Require approval for protected actions.
- Resume execution after approval.

### Enforcement responsibilities

- validate every file path against `allowed_root`
- resolve real paths and reject symlink escape
- classify bash commands into safe vs approval-required
- persist risky bash approvals by exact command fingerprint with `once`, `session`, and `global` scopes
- block actions denied by repo policy

### Approval types

- edit files
- run risky bash command
- create commit
- create pull request

### UI work

- approvals inbox
- approval detail panel
- approve risky bash commands once, for the session, or globally
- reject actions

### Acceptance criteria

- A task requiring edits pauses and creates an approval record.
- After approval, execution resumes.
- Risky bash commands can be re-enabled per command instead of disabling the entire bash tool.
- Blocked paths and commands produce audit events.

## Milestone 5: Diff Review And Git Workflow

### Goals

- Create branch context for change tasks.
- Show changed files and diff in the UI.
- Support commit approval.

### Backend work

- branch creation helper
- git diff capture
- commit action
- branch status persistence

### UI work

- diff viewer
- changed files list
- branch and commit status card

### Acceptance criteria

- User can review the diff before commit or PR.
- Branch state is visible on the task detail page.

## Milestone 6: Pull Request Workflow

### Goals

- Create a PR from the task branch.
- Store PR URL and metadata.
- Link tasks to PRs.

### Backend work

- GitHub integration setup
- PR title and body generation helper
- create PR action
- PR metadata persistence

### UI work

- `Create PR` action
- PR link display
- PR status block

### Acceptance criteria

- User can create a PR from the web UI.
- PR URL is stored and visible on the task.

## Milestone 7: Security Hardening And Observability

### Goals

- Make the system trustworthy for daily use.
- Improve auditability and failure handling.

### Hardening work

- path canonicalization tests
- symlink escape tests
- command classification tests
- timeout limits
- per-task cost caps
- retry and escalation rules
- audit event coverage

### Acceptance criteria

- Denied actions are clearly logged.
- Task timeouts and escalation paths are visible.

## API Outline

### Repositories

- `GET /api/repos`
- `POST /api/repos/scan`
- `POST /api/repos`
- `GET /api/repos/:id`
- `PATCH /api/repos/:id/policy`

### Tasks

- `GET /api/tasks`
- `POST /api/tasks`
- `GET /api/tasks/:id`
- `POST /api/tasks/:id/retry`

### Approvals

- `GET /api/approvals`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`

### Git And PR

- `POST /api/tasks/:id/commit`
- `POST /api/tasks/:id/pr`
- `GET /api/tasks/:id/diff`

## Minimal UI Screens

- Repositories list
- Repository detail and policy editor
- New task page or modal
- Task list
- Task detail page
- Approvals inbox

Each task detail page should prioritize:

- final answer
- routing decision
- changed files
- diff
- branch state
- PR actions and links

## Testing Strategy

### Unit tests

- routing logic
- path validation
- command classification
- approval policy evaluation

### Integration tests

- repo scan and registration
- task submission and routing
- paused approval flow
- diff capture
- PR creation mock flow

### End-to-end tests

- register repo
- submit simple read-only task
- submit code change task
- approve edit
- review diff
- create PR

## Suggested Initial Backlog

### First coding slice

1. Bootstrap monorepo or app structure.
2. Add SQLite schema and migration setup.
3. Implement repository scan and registration.
4. Implement policy model and editor.
5. Implement task creation and routing.

### Second coding slice

1. Add pi runner wrapper.
2. Execute read-only tasks.
3. Persist task results and session references.
4. Render task detail page.

### Third coding slice

1. Add approval checkpoints.
2. Add diff capture.
3. Add commit and PR flow.

## Open Decisions To Resolve During Implementation

- Use pi SDK or RPC for the first integration.
- Decide whether policy enforcement wraps built-in pi tools or executes pi in a more restricted environment.
- Decide the exact GitHub auth mechanism for PR creation.
- Decide how much task summary and diff data should be stored directly in SQLite vs derived on demand.

## Recommended Immediate Next Step

Start by scaffolding the repository with:

- TanStack Start app
- backend API surface
- SQLite setup
- first database tables for repos, policies, tasks, approvals, and audit events

Then build the repo registry and policy editor before integrating pi execution.
