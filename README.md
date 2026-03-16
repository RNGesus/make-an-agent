# Pi Remote Control App

Monorepo scaffold for a web-first control plane around `pi-coding-agent`.

## Workspace

- `apps/web` - operator-facing UI shell for repositories, tasks, approvals, and diff review
- `apps/server` - backend API scaffold and orchestration module map
- `packages/shared` - shared domain types, route definitions, and milestone metadata
- `packages/db` - SQLite schema manifest and the first SQL migration
- `packages/policy-engine` - policy enforcement helpers for repo permissions and approvals
- `packages/task-router` - rules-first task routing scaffold
- `packages/pi-runner` - pi execution contract scaffold
- `packages/github` - pull request draft helpers and metadata contracts

## Commands

```bash
vp install
vp run dev
vp check
vp run test -r
vp run build -r
```

## Schema

The initial SQLite schema lives at `packages/db/migrations/0001_initial_schema.sql` and covers:

- repositories
- repository policies
- tasks
- task artifacts
- approvals
- audit events
