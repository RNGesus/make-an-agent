export const autonomyModes = ["read-only", "approve-writes", "approve-commits", "trusted"] as const;
export const taskGoalTypes = ["question", "plan", "implement", "fix", "refactor", "debug"] as const;
export const taskStatuses = [
  "queued",
  "routing",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;
export const routingTiers = ["cheap", "strong"] as const;
export const artifactTypes = [
  "changed_files",
  "diff_summary",
  "final_answer",
  "pr_metadata",
  "execution_notes",
] as const;
export const approvalTypes = ["edit", "risky_bash", "commit", "pull_request"] as const;
export const approvalStatuses = ["pending", "approved", "rejected"] as const;

export type AutonomyMode = (typeof autonomyModes)[number];
export type TaskGoalType = (typeof taskGoalTypes)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type RoutingTier = (typeof routingTiers)[number];
export type ArtifactType = (typeof artifactTypes)[number];
export type ApprovalType = (typeof approvalTypes)[number];
export type ApprovalStatus = (typeof approvalStatuses)[number];

export interface RepositoryRecord {
  id: string;
  name: string;
  root_path: string;
  parent_source: string;
  default_branch: string;
  remote_url: string | null;
  github_owner: string | null;
  github_repo: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RepositoryPolicyRecord {
  repo_id: string;
  autonomy_mode: AutonomyMode;
  allowed_root: string;
  allow_read: boolean;
  allow_edit: boolean;
  allow_bash: boolean;
  allow_git_write: boolean;
  allow_pr_create: boolean;
  safe_command_patterns: string[];
  approval_required_for_edit: boolean;
  approval_required_for_commit: boolean;
  approval_required_for_pr: boolean;
  approval_required_for_risky_bash: boolean;
  cheap_provider: string;
  cheap_model: string;
  strong_provider: string;
  strong_model: string;
  classifier_provider: string | null;
  classifier_model: string | null;
  max_escalations: number;
  max_task_budget_usd: number;
}

export interface TaskRecord {
  id: string;
  repo_id: string;
  title: string;
  user_prompt: string;
  goal_type: TaskGoalType;
  status: TaskStatus;
  routing_tier: RoutingTier | null;
  routing_reason: string | null;
  classifier_score: number | null;
  classifier_confidence: number | null;
  pi_session_id: string | null;
  branch_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface TaskArtifactRecord {
  id: string;
  task_id: string;
  artifact_type: ArtifactType;
  summary: string;
  payload_json: string;
  created_at: string;
}

export interface ApprovalRecord {
  id: string;
  task_id: string;
  approval_type: ApprovalType;
  requested_action: string;
  requested_payload_json: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface AuditEventRecord {
  id: string;
  repo_id: string | null;
  task_id: string | null;
  event_type: string;
  message: string;
  details_json: string;
  created_at: string;
}
