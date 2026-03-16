export interface WorkspacePackage {
  kind: "app" | "package";
  path: string;
  responsibility: string;
}

export interface DeliveryMilestone {
  id: string;
  title: string;
  summary: string;
}

export const workspacePackages: readonly WorkspacePackage[] = [
  {
    kind: "app",
    path: "apps/web",
    responsibility: "Operator UI shell for repo library, task intake, approvals, and diff review.",
  },
  {
    kind: "app",
    path: "apps/server",
    responsibility:
      "Backend API scaffold for routing, execution orchestration, and policy-backed actions.",
  },
  {
    kind: "package",
    path: "packages/db",
    responsibility: "SQLite schema manifest and migrations for control-plane state.",
  },
  {
    kind: "package",
    path: "packages/shared",
    responsibility:
      "Domain records, route definitions, and scaffolding metadata shared across apps.",
  },
  {
    kind: "package",
    path: "packages/pi-runner",
    responsibility: "Execution envelope contract for future pi SDK or RPC integration.",
  },
  {
    kind: "package",
    path: "packages/policy-engine",
    responsibility: "Permission and approval evaluation helpers for repo-scoped actions.",
  },
  {
    kind: "package",
    path: "packages/task-router",
    responsibility: "Rules-first routing decisions for cheap vs strong model selection.",
  },
  {
    kind: "package",
    path: "packages/github",
    responsibility: "Branch and pull-request metadata helpers for milestone five and six.",
  },
];

export const deliveryMilestones: readonly DeliveryMilestone[] = [
  {
    id: "M1",
    title: "Repository registry and policy foundation",
    summary: "Scan a parent workspace, register repos, and edit autonomy and model profiles.",
  },
  {
    id: "M2",
    title: "Task intake and routing",
    summary: "Create tasks, persist routing decisions, and expose routing reasons in the UI.",
  },
  {
    id: "M3",
    title: "Pi execution wrapper",
    summary: "Wrap pi sessions, capture artifacts, and store session references.",
  },
  {
    id: "M4",
    title: "Policy enforcement and approvals",
    summary: "Pause edits, risky bash commands, commits, and PRs behind explicit approval records.",
  },
  {
    id: "M5",
    title: "Diff review and git workflow",
    summary: "Track branches, capture diffs, and make commit approval a first-class step.",
  },
  {
    id: "M6",
    title: "Pull request workflow",
    summary: "Create PRs from task branches and persist links and metadata.",
  },
  {
    id: "M7",
    title: "Security hardening and observability",
    summary: "Cover path boundaries, command checks, cost limits, and auditability.",
  },
];
