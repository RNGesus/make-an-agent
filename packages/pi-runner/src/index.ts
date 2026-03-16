import type { RepositoryPolicyRecord, RepositoryRecord, RoutingTier, TaskRecord } from "shared";

export type PiRunnerMode = "sdk" | "rpc";

export interface PiExecutionRequest {
  mode: PiRunnerMode;
  repo: Pick<RepositoryRecord, "id" | "name" | "root_path">;
  policy: Pick<RepositoryPolicyRecord, "allowed_root" | "autonomy_mode" | "max_task_budget_usd">;
  task: Pick<TaskRecord, "id" | "title" | "user_prompt">;
  routing_tier: RoutingTier;
}

export interface PiExecutionEnvelope {
  mode: PiRunnerMode;
  session_key: string;
  workspace_root: string;
  artifact_targets: readonly string[];
  approval_checkpoints: readonly string[];
}

export function createPiExecutionEnvelope(request: PiExecutionRequest): PiExecutionEnvelope {
  return {
    mode: request.mode,
    session_key: `${request.repo.id}:${request.task.id}`,
    workspace_root: request.policy.allowed_root,
    artifact_targets: ["final_answer", "changed_files", "diff_summary", "execution_notes"],
    approval_checkpoints: ["edit", "risky_bash", "commit", "pull_request"],
  };
}
