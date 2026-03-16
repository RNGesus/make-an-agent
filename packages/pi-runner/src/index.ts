import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type {
  ArtifactType,
  RepositoryPolicyRecord,
  RepositoryRecord,
  RoutingTier,
  TaskGoalType,
  TaskRecord,
} from "shared";

export type PiRunnerMode = "sdk" | "rpc";

interface GitSnapshotFile {
  status: string;
  path: string;
  fingerprint: string | null;
}

interface GitSnapshot {
  changed_files: GitSnapshotFile[];
  diff_stat: string;
  diff_excerpt: string;
  diff_summary: string;
}

export interface PiExecutionRequest {
  mode: PiRunnerMode;
  repo: Pick<RepositoryRecord, "id" | "name" | "root_path" | "default_branch">;
  policy: Pick<RepositoryPolicyRecord, "allowed_root" | "autonomy_mode" | "max_task_budget_usd">;
  task: Pick<TaskRecord, "id" | "title" | "user_prompt" | "goal_type">;
  routing_tier: RoutingTier;
  model_profile: {
    provider: string;
    model: string;
  };
}

export interface PiExecutionEnvelope {
  mode: PiRunnerMode;
  session_key: string;
  workspace_root: string;
  artifact_targets: readonly string[];
  approval_checkpoints: readonly string[];
  provider: string;
  model: string;
  repo_name: string;
  repo_root: string;
  default_branch: string;
  task_id: string;
  task_title: string;
  task_prompt: string;
  task_goal_type: TaskGoalType;
  routing_tier: RoutingTier;
}

export interface PiExecutionArtifact {
  artifact_type: ArtifactType;
  summary: string;
  payload: unknown;
}

export interface PiExecutionResult {
  mode: PiRunnerMode;
  session_id: string;
  session_key: string;
  final_answer: string;
  artifacts: readonly PiExecutionArtifact[];
}

export interface PiExecutorOutput {
  final_answer: string;
  execution_notes?: readonly string[];
}

export type PiExecutor = (
  envelope: PiExecutionEnvelope,
) => PiExecutorOutput | Promise<PiExecutorOutput>;

export interface PiRunnerRuntime {
  execute?: PiExecutor;
  now?: () => Date;
}

export function createPiExecutionEnvelope(request: PiExecutionRequest): PiExecutionEnvelope {
  return {
    mode: request.mode,
    session_key: `${request.repo.id}:${request.task.id}`,
    workspace_root: request.policy.allowed_root,
    artifact_targets: ["final_answer", "changed_files", "diff_summary", "execution_notes"],
    approval_checkpoints: ["edit", "risky_bash", "commit", "pull_request"],
    provider: request.model_profile.provider,
    model: request.model_profile.model,
    repo_name: request.repo.name,
    repo_root: request.repo.root_path,
    default_branch: request.repo.default_branch,
    task_id: request.task.id,
    task_title: request.task.title,
    task_prompt: request.task.user_prompt,
    task_goal_type: request.task.goal_type,
    routing_tier: request.routing_tier,
  };
}

export async function executePiTask(
  request: PiExecutionRequest,
  runtime: PiRunnerRuntime = {},
): Promise<PiExecutionResult> {
  const envelope = createPiExecutionEnvelope(request);
  const executor = runtime.execute ?? defaultPiExecutor;
  const beforeGitArtifacts = captureGitArtifacts(envelope.workspace_root);
  const execution = await executor(envelope);
  const afterGitArtifacts = captureGitArtifacts(envelope.workspace_root);
  const gitArtifacts = summarizeGitDelta(beforeGitArtifacts, afterGitArtifacts);
  const finalAnswer = execution.final_answer.trim();
  const sessionId = `pi-${request.mode}:${randomUUID()}`;
  const notes = [
    `Execution mode: ${request.mode}.`,
    `Selected model: ${request.model_profile.provider}/${request.model_profile.model}.`,
    `Workspace root: ${envelope.workspace_root}.`,
    `Routing tier: ${request.routing_tier}.`,
    ...(execution.execution_notes ?? []),
  ];

  return {
    mode: request.mode,
    session_id: sessionId,
    session_key: envelope.session_key,
    final_answer: finalAnswer,
    artifacts: [
      {
        artifact_type: "final_answer",
        summary: summarizeText(finalAnswer),
        payload: { text: finalAnswer },
      },
      {
        artifact_type: "execution_notes",
        summary:
          gitArtifacts.changed_files.length === 0
            ? "Execution completed without workspace changes."
            : `Execution completed with ${gitArtifacts.changed_files.length} changed file(s).`,
        payload: {
          session_key: envelope.session_key,
          notes,
          provider: request.model_profile.provider,
          model: request.model_profile.model,
          workspace_root: envelope.workspace_root,
          approval_checkpoints: envelope.approval_checkpoints,
        },
      },
      {
        artifact_type: "changed_files",
        summary:
          gitArtifacts.changed_files.length === 0
            ? "No workspace changes detected after execution."
            : `${gitArtifacts.changed_files.length} workspace file(s) changed after execution.`,
        payload: {
          files: gitArtifacts.changed_files.map((file) => ({
            path: file.path,
            status: file.status,
          })),
        },
      },
      {
        artifact_type: "diff_summary",
        summary: gitArtifacts.diff_summary,
        payload: {
          stat: gitArtifacts.diff_stat,
          patch_excerpt: gitArtifacts.diff_excerpt,
        },
      },
    ],
  };
}

function defaultPiExecutor(envelope: PiExecutionEnvelope): PiExecutorOutput {
  return {
    final_answer: [
      `Mock ${envelope.mode.toUpperCase()} pi session for '${envelope.task_title}' completed.`,
      `The control plane persisted a session reference for ${envelope.repo_name}`,
      `using ${envelope.provider}/${envelope.model} on the ${envelope.routing_tier} tier.`,
      `This placeholder keeps Milestone 3 executable until the live pi binary or SDK is wired in.`,
    ].join(" "),
    execution_notes: [
      `Task goal type '${envelope.task_goal_type}' ran through the milestone-three wrapper.`,
      "The default executor is deterministic and read-only.",
    ],
  };
}

function captureGitArtifacts(workspaceRoot: string): GitSnapshot {
  const statusOutput = runGit(workspaceRoot, [
    "status",
    "--short",
    "--untracked-files=all",
    "--",
    ".",
  ]);
  const diffStat = runGit(workspaceRoot, ["diff", "--stat", "--", "."]);
  const diffPatch = runGit(workspaceRoot, ["diff", "--no-color", "--", "."]);
  const changedFiles = parseStatusLines(workspaceRoot, statusOutput);
  const trimmedStat = diffStat.trim();
  const trimmedPatch = diffPatch.trim();

  return {
    changed_files: changedFiles,
    diff_stat: trimmedStat,
    diff_excerpt: trimmedPatch ? trimmedPatch.slice(0, 8000) : "",
    diff_summary: trimmedStat || "No diff output was produced for the allowed workspace root.",
  };
}

function summarizeGitDelta(before: GitSnapshot, after: GitSnapshot): GitSnapshot {
  const repositoryWasDirty =
    before.changed_files.length > 0 ||
    before.diff_stat.length > 0 ||
    before.diff_excerpt.length > 0;

  if (!repositoryWasDirty) {
    return after;
  }

  const changedFiles = after.changed_files.filter(
    (afterFile) =>
      !before.changed_files.some(
        (beforeFile) =>
          beforeFile.path === afterFile.path &&
          beforeFile.status === afterFile.status &&
          beforeFile.fingerprint === afterFile.fingerprint,
      ),
  );

  return {
    changed_files: changedFiles,
    diff_stat: "",
    diff_excerpt: "",
    diff_summary:
      changedFiles.length === 0
        ? "Repository was already dirty before execution; no new workspace changes were attributed to this task."
        : `Repository was already dirty before execution, so only ${changedFiles.length} newly changed file(s) were attributed to this task.`,
  };
}

function runGit(workspaceRoot: string, args: string[]) {
  const result = spawnSync("git", ["-C", workspaceRoot, ...args], {
    encoding: "utf8",
  });

  return result.status === 0 ? result.stdout : "";
}

function parseStatusLines(workspaceRoot: string, output: string) {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => ({
      status: line.slice(0, 2).trim() || "modified",
      path: line.slice(3).trim(),
      fingerprint: fingerprintForPath(workspaceRoot, line.slice(3).trim()),
    }));
}

function fingerprintForPath(workspaceRoot: string, relativePath: string) {
  const normalizedPath = relativePath.includes(" -> ")
    ? (relativePath.split(" -> ").at(-1) ?? relativePath)
    : relativePath;
  const absolutePath = resolvePath(workspaceRoot, normalizedPath);

  if (!existsSync(absolutePath)) {
    return null;
  }

  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

function summarizeText(value: string) {
  return value.length <= 160 ? value : `${value.slice(0, 157).trimEnd()}...`;
}
