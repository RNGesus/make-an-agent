import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  SessionManager,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import type {
  ApprovalScope,
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
  execution_key: string;
  repo: Pick<RepositoryRecord, "id" | "name" | "root_path" | "default_branch">;
  policy: Pick<
    RepositoryPolicyRecord,
    | "allowed_root"
    | "autonomy_mode"
    | "max_task_budget_usd"
    | "allow_read"
    | "allow_edit"
    | "allow_bash"
    | "approval_required_for_risky_bash"
  >;
  task: Pick<TaskRecord, "id" | "title" | "user_prompt" | "goal_type">;
  routing_tier: RoutingTier;
  model_profile: {
    provider: string;
    model: string;
  };
}

export interface PiExecutionEnvelope {
  mode: PiRunnerMode;
  execution_key: string;
  session_key: string;
  workspace_root: string;
  allow_read: boolean;
  allow_edit: boolean;
  allow_bash: boolean;
  approval_required_for_risky_bash: boolean;
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
  session_id?: string;
  session_file?: string | null;
}

export type PiExecutor = (
  envelope: PiExecutionEnvelope,
) => PiExecutorOutput | Promise<PiExecutorOutput>;

export interface PiBashAuthorizationContext {
  envelope: PiExecutionEnvelope;
  command: string;
  timeout?: number;
}

export type PiBashAuthorizationDecision =
  | { status: "allow"; scope?: ApprovalScope | null }
  | { status: "deny"; reason: string }
  | {
      status: "require_approval";
      requested_action: string;
      payload: Record<string, unknown>;
    };

export interface PiRunnerRuntime {
  execute?: PiExecutor;
  now?: () => Date;
  authorizeBashCommand?: (
    context: PiBashAuthorizationContext,
  ) => PiBashAuthorizationDecision | Promise<PiBashAuthorizationDecision>;
}

interface PiSessionState {
  session_id: string;
  session_file: string | null;
}

export class PiCommandApprovalRequiredError extends Error {
  readonly approval_type = "risky_bash" as const;
  readonly requested_action: string;
  readonly requested_payload: Record<string, unknown>;

  constructor(requestedAction: string, requestedPayload: Record<string, unknown>) {
    super(requestedAction);
    this.name = "PiCommandApprovalRequiredError";
    this.requested_action = requestedAction;
    this.requested_payload = requestedPayload;
  }
}

export class PiExecutionBlockedError extends Error {
  readonly action: "bash";

  constructor(message: string) {
    super(message);
    this.name = "PiExecutionBlockedError";
    this.action = "bash";
  }
}

export function createPiExecutionEnvelope(request: PiExecutionRequest): PiExecutionEnvelope {
  return {
    mode: request.mode,
    execution_key: request.execution_key,
    session_key: request.execution_key,
    workspace_root: request.policy.allowed_root,
    allow_read: request.policy.allow_read,
    allow_edit: request.policy.allow_edit,
    allow_bash: request.policy.allow_bash,
    approval_required_for_risky_bash: request.policy.approval_required_for_risky_bash,
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
  const beforeGitArtifacts = captureGitArtifacts(envelope.workspace_root);
  const execution = runtime.execute
    ? await runtime.execute(envelope)
    : await livePiExecutor(envelope, runtime);
  const afterGitArtifacts = captureGitArtifacts(envelope.workspace_root);
  const gitArtifacts = summarizeGitDelta(beforeGitArtifacts, afterGitArtifacts);
  const finalAnswer = execution.final_answer.trim();
  const sessionId = execution.session_id ?? `pi-${request.mode}:${randomUUID()}`;
  const notes = [
    `Requested execution mode: ${request.mode}.`,
    `Selected model: ${request.model_profile.provider}/${request.model_profile.model}.`,
    `Workspace root: ${envelope.workspace_root}.`,
    `Routing tier: ${request.routing_tier}.`,
    ...(execution.session_file ? [`Session file: ${execution.session_file}.`] : []),
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

async function livePiExecutor(
  envelope: PiExecutionEnvelope,
  runtime: PiRunnerRuntime = {},
): Promise<PiExecutorOutput> {
  if (envelope.mode === "rpc") {
    return executeWithRpc(envelope, runtime);
  }

  return executeWithSdk(envelope, runtime);
}

async function executeWithSdk(
  envelope: PiExecutionEnvelope,
  runtime: PiRunnerRuntime = {},
): Promise<PiExecutorOutput> {
  const sessionState = createPiSessionState(envelope.workspace_root);
  const { session } = await createAgentSession({
    cwd: envelope.workspace_root,
    sessionManager: SessionManager.open(sessionState.session_file ?? ""),
    tools: createPiTools(envelope, runtime),
  });
  const selectedModel = session.modelRegistry.find(envelope.provider, envelope.model);

  if (!selectedModel) {
    session.dispose();
    throw new Error(`Pi could not resolve model '${envelope.provider}/${envelope.model}'.`);
  }

  await session.setModel(selectedModel);

  try {
    await session.prompt(buildPiTaskPrompt(envelope));
    await waitForAgentIdle(session);
    const stats = session.getSessionStats();

    return {
      final_answer:
        session.getLastAssistantText()?.trim() ||
        `Pi completed '${envelope.task_title}' without returning assistant text.`,
      execution_notes: [
        `SDK session ${session.sessionId} persisted for ${envelope.repo_name}.`,
        stats.toolCalls === 0
          ? "The agent answered without calling any tools."
          : `The agent executed ${stats.toolCalls} tool call(s).`,
      ],
      session_id: `pi-sdk:${session.sessionId}`,
      session_file: session.sessionFile ?? sessionState.session_file,
    };
  } finally {
    session.dispose();
  }
}

async function executeWithRpc(
  envelope: PiExecutionEnvelope,
  runtime: PiRunnerRuntime = {},
): Promise<PiExecutorOutput> {
  if (
    runtime.authorizeBashCommand &&
    envelope.allow_bash &&
    envelope.approval_required_for_risky_bash
  ) {
    const execution = await executeWithSdk(envelope, runtime);

    return {
      ...execution,
      execution_notes: [
        "Requested RPC mode but executed through the SDK to enforce per-command bash approvals.",
        ...(execution.execution_notes ?? []),
      ],
    };
  }

  const sessionState = createPiSessionState(envelope.workspace_root);
  const prompt = buildPiTaskPrompt(envelope);
  const args = [
    "--print",
    "--session",
    sessionState.session_file ?? "",
    "--provider",
    envelope.provider,
    "--model",
    envelope.model,
    "--tools",
    buildRpcToolsArgument(envelope),
    prompt,
  ];
  const result = await runPiCommand(args, envelope.workspace_root);

  if (result.exit_code !== 0) {
    throw new Error(result.stderr || result.stdout || `pi exited with status ${result.exit_code}.`);
  }

  return {
    final_answer:
      result.stdout.trim() ||
      `Pi completed '${envelope.task_title}' without returning assistant text.`,
    execution_notes: [
      `RPC CLI session ${sessionState.session_id} persisted for ${envelope.repo_name}.`,
      ...(result.stderr.trim() ? [`pi stderr: ${result.stderr.trim()}`] : []),
    ],
    session_id: `pi-rpc:${sessionState.session_id}`,
    session_file: sessionState.session_file,
  };
}

function createPiSessionState(workspaceRoot: string): PiSessionState {
  const sessionManager = SessionManager.create(workspaceRoot);

  return {
    session_id: sessionManager.getSessionId(),
    session_file: sessionManager.getSessionFile() ?? null,
  };
}

function createPiTools(envelope: PiExecutionEnvelope, runtime: PiRunnerRuntime) {
  const tools = [];
  const allowBashTools =
    envelope.allow_bash &&
    (!envelope.approval_required_for_risky_bash || Boolean(runtime.authorizeBashCommand));
  const allowEditTools =
    envelope.allow_edit &&
    envelope.task_goal_type !== "question" &&
    envelope.task_goal_type !== "plan";

  if (envelope.allow_read) {
    tools.push(
      createReadTool(envelope.workspace_root),
      createGrepTool(envelope.workspace_root),
      createFindTool(envelope.workspace_root),
      createLsTool(envelope.workspace_root),
    );
  }

  if (allowBashTools) {
    tools.push(createGuardedBashTool(envelope, runtime));
  }

  if (allowEditTools) {
    tools.push(createEditTool(envelope.workspace_root), createWriteTool(envelope.workspace_root));
  }

  return tools;
}

function createGuardedBashTool(envelope: PiExecutionEnvelope, runtime: PiRunnerRuntime) {
  const bashTool = createBashTool(envelope.workspace_root);

  if (!runtime.authorizeBashCommand) {
    return bashTool;
  }

  return {
    ...bashTool,
    execute: async (...args: Parameters<typeof bashTool.execute>) => {
      const [, input] = args;
      const decision = await runtime.authorizeBashCommand?.({
        envelope,
        command: input.command,
        timeout: input.timeout,
      });

      if (!decision || decision.status === "allow") {
        return bashTool.execute(...args);
      }

      if (decision.status === "deny") {
        throw new PiExecutionBlockedError(decision.reason);
      }

      throw new PiCommandApprovalRequiredError(decision.requested_action, decision.payload);
    },
  };
}

function buildRpcToolsArgument(envelope: PiExecutionEnvelope) {
  const toolNames = envelope.allow_read ? ["read", "grep", "find", "ls"] : [];

  if (
    envelope.allow_edit &&
    envelope.task_goal_type !== "question" &&
    envelope.task_goal_type !== "plan"
  ) {
    toolNames.push("edit", "write");
  }

  if (envelope.allow_bash && !envelope.approval_required_for_risky_bash) {
    toolNames.push("bash");
  }

  return toolNames.join(",");
}

function buildPiTaskPrompt(envelope: PiExecutionEnvelope) {
  return [
    `Repository: ${envelope.repo_name}`,
    `Workspace root: ${envelope.workspace_root}`,
    `Default branch: ${envelope.default_branch}`,
    `Task title: ${envelope.task_title}`,
    `Goal type: ${envelope.task_goal_type}`,
    `Routing tier: ${envelope.routing_tier}`,
    "Stay inside the workspace root and use repository-aware tools when needed.",
    "User request:",
    envelope.task_prompt,
  ].join("\n\n");
}

async function waitForAgentIdle(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
) {
  const agent = session.agent as { waitForIdle?: () => Promise<void> };

  if (!agent.waitForIdle) {
    throw new Error("Pi SDK agent does not expose waitForIdle().");
  }

  await agent.waitForIdle();
}

async function runPiCommand(args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string; exit_code: number | null }>(
    (resolve, reject) => {
      const child = spawn("pi", args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({ stdout, stderr, exit_code: exitCode });
      });
    },
  );
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
