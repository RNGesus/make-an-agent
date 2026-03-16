export interface SchemaTable {
  name: string;
  purpose: string;
  key_columns: readonly string[];
}

export const schemaTables: readonly SchemaTable[] = [
  {
    name: "repositories",
    purpose: "Registered repositories, Git metadata, and whether a repo is active for task intake.",
    key_columns: [
      "id",
      "name",
      "root_path",
      "default_branch",
      "remote_url",
      "is_active",
      "created_at",
      "updated_at",
    ],
  },
  {
    name: "repository_policies",
    purpose: "Per-repo autonomy, tool permissions, approval gates, and model profile settings.",
    key_columns: [
      "repo_id",
      "autonomy_mode",
      "allowed_root",
      "allow_read",
      "allow_edit",
      "allow_bash",
      "allow_git_write",
      "allow_pr_create",
      "safe_command_patterns_json",
      "max_task_budget_usd",
    ],
  },
  {
    name: "tasks",
    purpose: "User-submitted work items, routing output, session references, and execution state.",
    key_columns: [
      "id",
      "repo_id",
      "title",
      "user_prompt",
      "goal_type",
      "status",
      "routing_tier",
      "pi_session_id",
      "branch_name",
      "created_at",
    ],
  },
  {
    name: "task_artifacts",
    purpose:
      "Compact task results such as final answers, diff summaries, and PR metadata snapshots.",
    key_columns: ["id", "task_id", "artifact_type", "summary", "payload_json", "created_at"],
  },
  {
    name: "approvals",
    purpose:
      "Pending and resolved approval checkpoints for edits, commits, PRs, and risky commands.",
    key_columns: [
      "id",
      "task_id",
      "approval_type",
      "requested_action",
      "requested_payload_json",
      "status",
      "decided_at",
      "created_at",
    ],
  },
  {
    name: "audit_events",
    purpose:
      "Durable log for policy decisions, denied actions, and execution lifecycle milestones.",
    key_columns: [
      "id",
      "repo_id",
      "task_id",
      "event_type",
      "message",
      "details_json",
      "created_at",
    ],
  },
] as const;

export const initialMigration = {
  id: "0001_initial_schema",
  path: "packages/db/migrations/0001_initial_schema.sql",
  table_count: schemaTables.length,
} as const;

export const connectionPragmas = ["PRAGMA foreign_keys = ON"] as const;
