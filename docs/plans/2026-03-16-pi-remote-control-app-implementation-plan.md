# Pi Remote Control App Implementation Plan

Date: 2026-03-16
Status: Draft

Phase 0 status: Implemented and verified on 2026-03-17

## Objective

Implement the approved MVP for a web-first control plane around `pi-coding-agent` that can:

- register existing server-local repositories
- enforce per-repo security policies
- route tasks between cheap and strong models
- execute coding tasks through pi
- pause for approvals when required
- show diffs
- create pull requests and store PR links

The repository already contains partial implementation for the backend, database, shared packages, and an interim web UI. The remaining work should realign the web foundation safely, preserve usable code, and then continue milestone delivery from an accurate current-state baseline.

## Delivery Strategy

Build the system in vertical slices so each milestone produces a usable feature.

Recommended order:

0. Foundation realignment and current-state audit.
1. Repository registry and policy foundation.
2. Task intake and model routing.
3. Pi execution integration.
4. Approval and diff review.
5. Branch, commit, and PR workflow.
6. Security hardening and observability.

## Current State Assessment

The codebase has already moved beyond a pure scaffold stage, but it does not yet match the planned application foundation.

### Already present

- `apps/web` contains a working operator UI for repository import, policy editing, task intake, approvals, task history, and task detail.
- `apps/server` already exposes repository, task, and approval-oriented modules.
- `packages/db` already contains the initial SQLite schema.
- `packages/task-router`, `packages/policy-engine`, `packages/pi-runner`, and `packages/github` already exist as integration points.

### Current mismatch

- `apps/web` is still a plain Vite app instead of TanStack Start.
- The current UI is concentrated in a single large entry file instead of a route-oriented application structure.
- The implementation plan still reads like a greenfield scaffold, which no longer reflects the actual starting point.

### Planning implication

Before continuing milestone delivery, complete a foundation realignment phase that migrates the web app in place, preserves existing flows, and produces a concrete gap list for Milestones 1 through 4.

## Proposed Application Structure

```text
apps/
  web/                # TanStack Start UI migrated from the current Vite shell
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

## Phase 0: Foundation Realignment And Current-State Audit

### Goals

- Migrate `apps/web` from plain Vite to TanStack Start without discarding the current operator flows.
- Break the current web entrypoint into a safer route, layout, and component structure.
- Preserve existing server APIs and shared package contracts during the migration.
- Produce an implementation gap audit for Milestones 1 through 4 so the next work is based on reality.

### Web work

- Scaffold TanStack Start in `apps/web`.
- Create route and layout structure for the existing operator surface.
- Move the current repository, policy, task, approval, and task-detail UI into TanStack Start routes and components.
- Keep the current API contract working throughout the migration.

### Backend and package work

- Preserve the current `apps/server` surface so the migration does not block existing flows.
- Verify that shared package boundaries are still appropriate once the web app is route-oriented.
- Capture follow-up cleanup tasks instead of mixing them into the migration unless they are blocking.

### Audit output

Document which items in Milestones 1 through 4 are:

- already implemented
- partially implemented
- blocked by the old web foundation
- still missing

### Acceptance criteria

- `apps/web` runs as a TanStack Start app.
- Existing operator flows still work after the migration.
- The plan for Milestones 1 through 4 is updated from assumptions to verified remaining work.

### Verified Phase 0 Route Map

- `/repos`
- `/repos/$repoId`
- `/repos/$repoId/tasks/$taskId`
- `/approvals`
- `/approvals/$approvalId`

### Verified Phase 0 Component Buckets

- Root shell and navigation: `src/routes/__root.tsx`, `src/router.tsx`, `src/components/operator-layout.tsx`
- Repository import surface: `src/components/repository-panels.tsx`
- Policy editing surface: `src/components/policy-panel.tsx`
- Task intake, history, and detail surfaces: `src/components/task-panels.tsx`
- Approval inbox and resolution surface: `src/components/approval-panel.tsx`
- Shared client state and API helpers: `src/lib/operator-app.tsx`, `src/lib/repo-workspace.ts`, `src/lib/operator-api.ts`

## Milestone Status Snapshot After Phase 0 Verification

### Milestone 1

Mostly implemented and re-verified.

- Already implemented: repository scan, repository registration, repository listing, policy patching, allowed-root validation, default policy generation, and route-oriented repo views.
- Still missing or shallow: editing `safe_command_patterns` in the web UI, stronger repo-detail presentation beyond the current operator dashboard, and explicit UX around inactive repositories.

### Milestone 2

Mostly implemented and re-verified.

- Already implemented: task creation, inferred goal typing, cheap-vs-strong routing persistence, classifier metadata persistence, task retry, task history, and route-based task detail pages.
- Still missing or shallow: dedicated UX for diff route access, clearer routing-history presentation, and tighter separation between repo overview and task-focused screens.

### Milestone 3

Partially implemented and verified.

- Already implemented: pi-runner integration, persisted `pi_session_id`, final-answer artifacts, changed-file capture, diff-summary capture, and execution-note storage with server tests covering completion paths.
- Still missing or shallow: richer lifecycle visibility, stronger operational controls around long-running execution, and explicit verification of storage/query ergonomics outside the current happy-path tests.

### Milestone 4

Partially implemented and verified.

- Already implemented: approval queue listing, edit approvals, risky bash approvals with once/session/global scopes, reject flow, resume flow, approval history rendering, and concurrency coverage in server tests.
- Still missing or shallow: a dedicated diff-review action in the UI, broader policy-enforcement coverage at the UI layer, and more explicit operator guidance around why a task paused and what will resume after approval.

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

- Consolidate the existing repository and policy features on top of the migrated web foundation.
- Configure a parent directory such as `/srv/agent-workspaces/`.
- Discover candidate repositories from immediate subfolders.
- Register repositories into the application.
- Create and edit per-repo policy.

### Backend work

- Verify and tighten the current repo scan and registration behavior against the approved design.
- Add config for `WORKSPACE_PARENT_DIR`.
- Create repo scan service.
- Create repo registration endpoints.
- Create policy CRUD endpoints.

### UI work

- Move the existing repository library and policy editor into the final route-oriented structure.
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

- Consolidate the existing task intake and routing flow after the web migration.
- Submit tasks against a selected repository.
- Compute deterministic intensity score.
- Optionally run a cheap classifier for ambiguous tasks.
- Persist routing decisions.

### Backend work

- Verify current routing behavior and fill any rule or persistence gaps.
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

- Move the current task creation, task list, and task detail flows into their final app routes.
- New task form.
- Task list.
- Task detail page with routing reason.

### Acceptance criteria

- Every task stores model tier and routing explanation.
- User can see why a task used a cheap or strong model.

## Milestone 3: Pi Execution Wrapper

### Goals

- Consolidate and verify the existing pi integration points after Phase 0.
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

- Consolidate and harden the existing approval flow after the foundation migration.
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

- Keep the current approvals workflow working while moving it into the final route layout.
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

1. Scaffold TanStack Start in `apps/web`.
2. Introduce route, layout, and component structure around the current operator UI.
3. Migrate the existing repository, policy, task, approval, and task detail flows into that structure.
4. Keep the current API contract working during the migration.
5. Produce a verified gap list for Milestones 1 through 4.

### Second coding slice

1. Close remaining Milestone 1 gaps in repo registry and policy behavior.
2. Close remaining Milestone 2 gaps in task intake and routing.
3. Verify persisted task results and session references against the plan.
4. Tighten the task detail route structure after the migration settles.

### Third coding slice

1. Close remaining Milestone 3 gaps in pi execution handling.
2. Close remaining Milestone 4 gaps in approvals and diff capture.
3. Then continue with commit and PR flow.

## Open Decisions To Resolve During Implementation

- Use pi SDK or RPC for the first integration.
- Decide whether policy enforcement wraps built-in pi tools or executes pi in a more restricted environment.
- Decide the exact GitHub auth mechanism for PR creation.
- Decide how much task summary and diff data should be stored directly in SQLite vs derived on demand.

## Recommended Immediate Next Step

Start with Phase 0 foundation realignment:

- scaffold TanStack Start in `apps/web`
- preserve the current backend API surface and package contracts
- migrate the current operator UI into TanStack Start routes and components
- produce a milestone gap audit based on the migrated app

Then resume Milestone 1 work from the verified gap list instead of from a greenfield scaffold assumption.
