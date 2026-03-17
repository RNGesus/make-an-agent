import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, relative as relativePath, resolve as resolvePath, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  bootstrapControlPlaneDatabase,
  claimTaskExecution,
  consumeRiskyBashGrant,
  createApproval,
  createRiskyBashGrant,
  createTask,
  findReusableRiskyBashGrant,
  getApproval,
  getLatestApprovedTaskApproval,
  getPendingTaskApproval,
  getTaskDetail,
  getTaskExecutionContext,
  getRepositoryDetail,
  getRepositoryByRootPath,
  listApprovals,
  listTasks,
  listRepositories,
  recordAuditEvent,
  registerRepository,
  replaceTaskArtifacts,
  resolveApproval,
  type RepositoryPolicyValues,
  upsertTaskArtifacts,
  updateTaskExecution,
  updateRepositoryPolicy,
} from "db/runtime";
import { buildPullRequestDraft } from "github";
import { evaluatePolicyAction } from "policy-engine";
import {
  approvalScopes,
  autonomyModes,
  taskGoalTypes,
  type ApprovalScope,
  type AutonomyMode,
  type RiskyBashApprovalRequestPayload,
  type TaskGoalType,
} from "shared";
import { resolveTaskRoute } from "task-router";
import {
  PiCommandApprovalRequiredError,
  PiExecutionBlockedError,
  executePiTask,
  type PiExecutionRequest,
  type PiExecutor,
  type PiRunnerRuntime,
} from "pi-runner";
import type { ServerConfig } from "./config.ts";
import { defaultServerConfig } from "./config.ts";

export interface RepositoryScanCandidate {
  name: string;
  root_path: string;
  parent_source: string;
  default_branch: string;
  remote_url: string | null;
  github_owner: string | null;
  github_repo: string | null;
  is_registered: boolean;
  registered_repo_id: string | null;
}

export interface ServerApp {
  config: ServerConfig;
  handleRequest(request: Request): Promise<Response>;
  close(): void;
}

type PolicyPatch = Partial<RepositoryPolicyValues>;

const booleanPolicyKeys = [
  "allow_read",
  "allow_edit",
  "allow_bash",
  "allow_git_write",
  "allow_pr_create",
  "approval_required_for_edit",
  "approval_required_for_commit",
  "approval_required_for_pr",
  "approval_required_for_risky_bash",
] as const;

const stringPolicyKeys = [
  "cheap_provider",
  "cheap_model",
  "strong_provider",
  "strong_model",
] as const;

const nullableStringPolicyKeys = ["classifier_provider", "classifier_model"] as const;
const numberPolicyKeys = ["max_escalations", "max_task_budget_usd"] as const;

type RegisterRepositoryBody = {
  root_path: string;
  name?: string;
  default_branch?: string;
  remote_url?: string | null;
  github_owner?: string | null;
  github_repo?: string | null;
  parent_source?: string;
  policy?: PolicyPatch;
};

type CreateTaskBody = {
  repo_id: string;
  title?: string;
  user_prompt: string;
  goal_type?: string;
  expected_file_count?: number;
};

type ApprovalDecisionBody = {
  decided_by?: string;
  scope?: string;
};

type CommitTaskBody = {
  message?: string;
};

type CreatePullRequestBody = {
  title?: string;
  body?: string;
};

type OperatorActionKind = "commit" | "pull_request";

type OperatorActionRequestPayload = {
  approval_flow: "operator_action";
  operator_action: OperatorActionKind;
  repo_id: string;
  repo_name: string;
  task_id: string;
  task_title: string;
  goal_type: TaskGoalType;
  routing_tier: "cheap" | "strong" | null;
  branch_name: string;
  commit_message: string | null;
  pr_title: string | null;
  pr_body: string | null;
};

type TaskDiffResponse = {
  base_branch: string;
  branch_name: string | null;
  current_branch: string | null;
  head_sha: string | null;
  ahead_by: number;
  behind_by: number;
  has_changes: boolean;
  changed_files: Array<{ path: string; status: string }>;
  diff_stat: string;
  patch: string;
};

type TaskActionResponse = {
  approval: ReturnType<typeof getApproval>;
  task: NonNullable<ReturnType<typeof getTaskDetail>>;
};

export interface CreateServerAppOptions extends Partial<ServerConfig> {
  pi_execute?: PiExecutor;
}

export function createServerApp(options: CreateServerAppOptions = {}): ServerApp {
  const { pi_execute, ...configOverrides } = options;
  const config: ServerConfig = {
    ...defaultServerConfig,
    ...configOverrides,
  };
  const database = bootstrapControlPlaneDatabase({ databasePath: config.database_path });
  const piRuntime: PiRunnerRuntime | undefined = pi_execute ? { execute: pi_execute } : {};

  return {
    config,
    async handleRequest(request) {
      return routeRequest(request, config, database, piRuntime);
    },
    close() {
      database.close();
    },
  };
}

async function routeRequest(
  request: Request,
  config: ServerConfig,
  database: ReturnType<typeof bootstrapControlPlaneDatabase>,
  piRuntime?: PiRunnerRuntime,
) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return isAllowedOrigin(request, config)
      ? new Response(null, { status: 204, headers: corsHeaders(request, config) })
      : new Response(null, { status: 403 });
  }

  if (request.method === "GET" && url.pathname === "/api/repos") {
    return jsonResponse(request, config, 200, { repositories: listRepositories(database) });
  }

  if (request.method === "POST" && url.pathname === "/api/repos/scan") {
    const candidates = scanWorkspaceParent(config.workspace_parent_dir, database);
    return jsonResponse(request, config, 200, {
      parent_dir: config.workspace_parent_dir,
      candidates,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/repos") {
    const body = await readJsonBody(request);

    if (!isRegisterRepositoryBody(body)) {
      return jsonResponse(request, config, 400, {
        error: "Repository registration requests must include a string root_path.",
      });
    }

    try {
      const existing = getRepositoryByRootPath(database, realpathSync(body.root_path));
      const metadata = inspectRepositoryRoot(body.root_path, config.workspace_parent_dir);

      if (!metadata) {
        throw new Error(
          `'${body.root_path}' is not a git repository root inside the workspace parent.`,
        );
      }

      const policyPatch = normalizePolicyPatch(body.policy ?? {});
      const allowedRoot = assertAllowedRootWithinRepo(
        metadata.root_path,
        policyPatch.allowed_root ?? metadata.root_path,
      );

      const detail = registerRepository(database, {
        name: body.name ?? metadata.name,
        root_path: metadata.root_path,
        parent_source: body.parent_source ?? config.workspace_parent_dir,
        default_branch: body.default_branch ?? metadata.default_branch,
        remote_url: body.remote_url ?? metadata.remote_url,
        github_owner: body.github_owner ?? metadata.github_owner,
        github_repo: body.github_repo ?? metadata.github_repo,
        policy: buildRepositoryPolicy(allowedRoot, config.default_autonomy_mode, policyPatch),
      });

      return jsonResponse(request, config, existing ? 200 : 201, detail);
    } catch (error) {
      return jsonResponse(request, config, 400, {
        error: error instanceof Error ? error.message : "Could not register repository.",
      });
    }
  }

  const detailMatch = matchRepositoryDetail(url.pathname);

  if (request.method === "GET" && detailMatch) {
    const detail = getRepositoryDetail(database, detailMatch.repoId);

    return detail
      ? jsonResponse(request, config, 200, detail)
      : jsonResponse(request, config, 404, {
          error: `Repository '${detailMatch.repoId}' was not found.`,
        });
  }

  const policyMatch = matchRepositoryPolicy(url.pathname);

  if (request.method === "PATCH" && policyMatch) {
    const body = await readJsonBody(request);

    if (!isObject(body)) {
      return jsonResponse(request, config, 400, {
        error: "Repository policy updates must be a JSON object.",
      });
    }

    try {
      const existingDetail = getRepositoryDetail(database, policyMatch.repoId);

      if (!existingDetail) {
        return jsonResponse(request, config, 404, {
          error: `Repository '${policyMatch.repoId}' was not found.`,
        });
      }

      const patch = normalizePolicyPatch(body);

      if (patch.allowed_root) {
        patch.allowed_root = assertAllowedRootWithinRepo(
          existingDetail.repository.root_path,
          patch.allowed_root,
        );
      }

      const detail = updateRepositoryPolicy(database, policyMatch.repoId, patch);

      return detail
        ? jsonResponse(request, config, 200, detail)
        : jsonResponse(request, config, 404, {
            error: `Repository '${policyMatch.repoId}' was not found.`,
          });
    } catch (error) {
      return jsonResponse(request, config, 400, {
        error: error instanceof Error ? error.message : "Could not update repository policy.",
      });
    }
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    const repoId = url.searchParams.get("repo_id") ?? undefined;
    return jsonResponse(request, config, 200, { tasks: listTasks(database, repoId) });
  }

  if (request.method === "GET" && url.pathname === "/api/approvals") {
    return jsonResponse(request, config, 200, {
      approvals: listApprovals(database),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJsonBody(request);

    if (!isCreateTaskBody(body)) {
      return jsonResponse(request, config, 400, {
        error: "Task creation requests must include string repo_id and user_prompt fields.",
      });
    }

    const repoDetail = getRepositoryDetail(database, body.repo_id);

    if (!repoDetail) {
      return jsonResponse(request, config, 404, {
        error: `Repository '${body.repo_id}' was not found.`,
      });
    }

    if (!repoDetail.repository.is_active) {
      return jsonResponse(request, config, 400, {
        error: `Repository '${body.repo_id}' is inactive and cannot accept tasks.`,
      });
    }

    if (body.user_prompt.trim().length === 0) {
      return jsonResponse(request, config, 400, {
        error: "Task user_prompt must not be empty.",
      });
    }

    if (
      body.expected_file_count !== undefined &&
      (!Number.isInteger(body.expected_file_count) || body.expected_file_count < 0)
    ) {
      return jsonResponse(request, config, 400, {
        error: "expected_file_count must be a non-negative integer when provided.",
      });
    }

    try {
      const routingGoalType = resolveTaskGoalType(body.goal_type, body.user_prompt, body.title);
      const routing = resolveTaskRoute({
        title: body.title,
        prompt: body.user_prompt,
        goal_type: routingGoalType,
        expected_file_count: body.expected_file_count,
      });
      const task = createTask(database, {
        repo_id: repoDetail.repository.id,
        title: normalizeTaskTitle(body.title, body.user_prompt),
        user_prompt: body.user_prompt.trim(),
        goal_type: routingGoalType ?? "question",
        status: "queued",
        routing_tier: routing.tier,
        routing_reason: routing.reason,
        classifier_score: routing.classifier_score,
        classifier_confidence: routing.classifier_confidence,
        pi_session_id: null,
        branch_name: null,
        started_at: null,
        completed_at: null,
      });

      const executedTask = await maybeExecuteTask(
        database,
        config,
        task.task.id,
        "start",
        piRuntime,
      );

      return jsonResponse(request, config, 201, executedTask);
    } catch (error) {
      return jsonResponse(request, config, 400, {
        error: error instanceof Error ? error.message : "Could not create task.",
      });
    }
  }

  const taskDetailMatch = matchTaskDetail(url.pathname);

  if (request.method === "GET" && taskDetailMatch) {
    const detail = getTaskDetail(database, taskDetailMatch.taskId);

    return detail
      ? jsonResponse(request, config, 200, detail)
      : jsonResponse(request, config, 404, {
          error: `Task '${taskDetailMatch.taskId}' was not found.`,
        });
  }

  const taskRetryMatch = matchTaskRetry(url.pathname);

  if (request.method === "POST" && taskRetryMatch) {
    const detail = getTaskDetail(database, taskRetryMatch.taskId);

    if (!detail) {
      return jsonResponse(request, config, 404, {
        error: `Task '${taskRetryMatch.taskId}' was not found.`,
      });
    }

    const executedTask = await maybeExecuteTask(
      database,
      config,
      taskRetryMatch.taskId,
      "retry",
      piRuntime,
    );

    return jsonResponse(request, config, 200, executedTask);
  }

  const taskDiffMatch = matchTaskDiff(url.pathname);

  if (request.method === "GET" && taskDiffMatch) {
    try {
      const diff = getTaskDiff(database, taskDiffMatch.taskId);

      return diff
        ? jsonResponse(request, config, 200, diff)
        : jsonResponse(request, config, 404, {
            error: `Task '${taskDiffMatch.taskId}' was not found.`,
          });
    } catch (error) {
      return jsonResponse(request, config, 400, {
        error: error instanceof Error ? error.message : "Could not collect task diff.",
      });
    }
  }

  const taskCommitMatch = matchTaskCommit(url.pathname);

  if (request.method === "POST" && taskCommitMatch) {
    const body = await readJsonBody(request);

    if (body !== null && !isCommitTaskBody(body)) {
      return jsonResponse(request, config, 400, {
        error: "Commit requests must be a JSON object with an optional string message field.",
      });
    }

    try {
      const result = executeTaskOperatorAction(
        database,
        taskCommitMatch.taskId,
        "commit",
        body && isCommitTaskBody(body) ? body : {},
      );

      return jsonResponse(request, config, 200, result);
    } catch (error) {
      return jsonResponse(request, config, 400, {
        error: error instanceof Error ? error.message : "Could not commit task changes.",
      });
    }
  }

  const taskPullRequestMatch = matchTaskPullRequest(url.pathname);

  if (request.method === "POST" && taskPullRequestMatch) {
    const body = await readJsonBody(request);

    if (body !== null && !isCreatePullRequestBody(body)) {
      return jsonResponse(request, config, 400, {
        error:
          "Pull request requests must be a JSON object with optional string title and body fields.",
      });
    }

    try {
      const result = executeTaskOperatorAction(
        database,
        taskPullRequestMatch.taskId,
        "pull_request",
        body && isCreatePullRequestBody(body) ? body : {},
      );

      return jsonResponse(request, config, 200, result);
    } catch (error) {
      return jsonResponse(request, config, 400, {
        error: error instanceof Error ? error.message : "Could not create the task pull request.",
      });
    }
  }

  const approveMatch = matchApprovalApprove(url.pathname);

  if (request.method === "POST" && approveMatch) {
    const body = await readJsonBody(request);

    if (body !== null && !isApprovalDecisionBody(body)) {
      return jsonResponse(request, config, 400, {
        error: "Approval decisions must be a JSON object with an optional string decided_by field.",
      });
    }

    const approval = getApproval(database, approveMatch.approvalId);

    if (!approval) {
      return jsonResponse(request, config, 404, {
        error: `Approval '${approveMatch.approvalId}' was not found.`,
      });
    }

    if (approval.status !== "pending") {
      return jsonResponse(request, config, 409, {
        error: `Approval '${approveMatch.approvalId}' has already been resolved.`,
      });
    }

    const decisionBody: ApprovalDecisionBody = body && isApprovalDecisionBody(body) ? body : {};
    const decidedBy = normalizeDecisionActor(decisionBody.decided_by);
    const approvalScope =
      approval.approval_type === "risky_bash" ? toApprovalScope(decisionBody.scope) : null;

    if (approval.approval_type === "risky_bash" && !approvalScope) {
      return jsonResponse(request, config, 400, {
        error: "Risky bash approvals require a scope of once, session, or global.",
      });
    }

    const resolved = resolveApproval(database, approveMatch.approvalId, {
      status: "approved",
      decided_by: decidedBy,
      decided_at: new Date().toISOString(),
      resolution_payload_json: approvalScope ? JSON.stringify({ scope: approvalScope }) : "{}",
    });

    if (!resolved) {
      return jsonResponse(request, config, 409, {
        error: `Approval '${approveMatch.approvalId}' was already resolved by another request.`,
      });
    }

    const context = getTaskExecutionContext(database, resolved.task_id);
    const operatorPayload = parseOperatorActionRequestPayload(resolved.requested_payload_json);
    const riskyBashPayload =
      resolved.approval_type === "risky_bash"
        ? parseRiskyBashApprovalPayload(resolved.requested_payload_json)
        : null;

    if (resolved.approval_type === "risky_bash" && !riskyBashPayload) {
      return jsonResponse(request, config, 400, {
        error: "Risky bash approval payload is invalid and could not be resumed.",
      });
    }

    if (resolved.approval_type === "risky_bash" && riskyBashPayload && approvalScope) {
      createRiskyBashGrant(database, {
        approval_id: resolved.id,
        repo_id: riskyBashPayload.repo_id,
        task_id: approvalScope === "global" ? null : riskyBashPayload.task_id,
        session_key: approvalScope === "global" ? null : riskyBashPayload.session_key,
        scope: approvalScope,
        command: riskyBashPayload.command,
        command_fingerprint: riskyBashPayload.command_fingerprint,
        decided_by: decidedBy,
      });
    }

    if (context) {
      recordAuditEvent(
        database,
        context.repository.id,
        context.task.id,
        "task.approval.approved",
        "Approved the pending task action.",
        {
          approval_id: resolved.id,
          approval_type: resolved.approval_type,
          decided_by: decidedBy,
          ...(approvalScope ? { scope: approvalScope } : {}),
        },
      );
    }

    const task =
      operatorPayload?.approval_flow === "operator_action"
        ? executeApprovedOperatorAction(database, resolved.task_id, operatorPayload)
        : await maybeExecuteTask(database, config, resolved.task_id, "resume", piRuntime);

    return jsonResponse(request, config, 200, {
      approval: resolved,
      task,
    });
  }

  const rejectMatch = matchApprovalReject(url.pathname);

  if (request.method === "POST" && rejectMatch) {
    const body = await readJsonBody(request);

    if (body !== null && !isApprovalDecisionBody(body)) {
      return jsonResponse(request, config, 400, {
        error: "Approval decisions must be a JSON object with an optional string decided_by field.",
      });
    }

    const approval = getApproval(database, rejectMatch.approvalId);

    if (!approval) {
      return jsonResponse(request, config, 404, {
        error: `Approval '${rejectMatch.approvalId}' was not found.`,
      });
    }

    if (approval.status !== "pending") {
      return jsonResponse(request, config, 409, {
        error: `Approval '${rejectMatch.approvalId}' has already been resolved.`,
      });
    }

    const decisionBody: ApprovalDecisionBody = body && isApprovalDecisionBody(body) ? body : {};
    const decidedBy = normalizeDecisionActor(decisionBody.decided_by);
    const resolved = resolveApproval(database, rejectMatch.approvalId, {
      status: "rejected",
      decided_by: decidedBy,
      decided_at: new Date().toISOString(),
    });

    if (!resolved) {
      return jsonResponse(request, config, 409, {
        error: `Approval '${rejectMatch.approvalId}' was already resolved by another request.`,
      });
    }

    const context = getTaskExecutionContext(database, resolved.task_id);

    const operatorPayload = parseOperatorActionRequestPayload(resolved.requested_payload_json);

    if (context) {
      if (operatorPayload?.approval_flow === "operator_action") {
        recordAuditEvent(
          database,
          context.repository.id,
          context.task.id,
          "task.approval.rejected",
          "Rejected the pending task action.",
          {
            approval_id: resolved.id,
            approval_type: resolved.approval_type,
            decided_by: decidedBy,
            operator_action: operatorPayload.operator_action,
          },
        );
      } else {
        updateTaskExecution(database, resolved.task_id, {
          status: "failed",
          pi_session_id: context.task.pi_session_id,
          branch_name: context.task.branch_name,
          started_at: context.task.started_at,
          completed_at: new Date().toISOString(),
        });
        recordAuditEvent(
          database,
          context.repository.id,
          context.task.id,
          "task.approval.rejected",
          "Rejected the pending task action.",
          {
            approval_id: resolved.id,
            approval_type: resolved.approval_type,
            decided_by: decidedBy,
          },
        );
      }
    }

    return jsonResponse(request, config, 200, {
      approval: resolved,
      task: getTaskDetail(database, resolved.task_id),
    });
  }

  return jsonResponse(request, config, 404, {
    error: `No route matches ${request.method} ${url.pathname}.`,
  });
}

function scanWorkspaceParent(
  workspaceParentDir: string,
  database: ReturnType<typeof bootstrapControlPlaneDatabase>,
) {
  const parentRoot = realpathSync(workspaceParentDir);

  return readdirSync(parentRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => inspectRepositoryRoot(resolvePath(parentRoot, entry.name), parentRoot))
    .filter((candidate): candidate is RepositoryScanCandidate => candidate !== null)
    .map((candidate) => {
      const registered = getRepositoryByRootPath(database, candidate.root_path);

      return {
        ...candidate,
        is_registered: registered !== null,
        registered_repo_id: registered?.id ?? null,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function inspectRepositoryRoot(
  repoPath: string,
  workspaceParentDir: string,
): RepositoryScanCandidate | null {
  const rootPath = realpathSync(repoPath);
  const parentRoot = realpathSync(workspaceParentDir);

  if (!isImmediateChild(parentRoot, rootPath)) {
    throw new Error(`Repository root '${rootPath}' must be an immediate child of '${parentRoot}'.`);
  }

  const stats = statSync(rootPath);

  if (!stats.isDirectory()) {
    throw new Error(`Repository root '${rootPath}' is not a directory.`);
  }

  const topLevel = runGit(rootPath, ["rev-parse", "--show-toplevel"], false)?.trim();

  if (!topLevel) {
    return null;
  }

  const normalizedTopLevel = realpathSync(topLevel);

  if (normalizedTopLevel !== rootPath) {
    return null;
  }

  const remoteUrl = runGit(rootPath, ["remote", "get-url", "origin"], false)?.trim() ?? null;
  const github = parseGithubRemote(remoteUrl);
  const defaultBranch =
    stripOriginPrefix(
      runGit(rootPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], false)?.trim(),
    ) ?? fallbackBranch(rootPath);

  return {
    name: dirname(rootPath) === parentRoot ? (rootPath.split(sep).at(-1) ?? rootPath) : rootPath,
    root_path: rootPath,
    parent_source: parentRoot,
    default_branch: defaultBranch,
    remote_url: remoteUrl,
    github_owner: github?.owner ?? null,
    github_repo: github?.repo ?? null,
    is_registered: false,
    registered_repo_id: null,
  };
}

function fallbackBranch(rootPath: string) {
  const currentBranch = runGit(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"], false)?.trim();

  if (currentBranch && currentBranch !== "HEAD") {
    return currentBranch;
  }

  return "main";
}

function buildRepositoryPolicy(
  allowedRoot: string,
  defaultAutonomyMode: string,
  patch: PolicyPatch | undefined,
): RepositoryPolicyValues {
  const autonomyMode = toAutonomyMode(patch?.autonomy_mode ?? defaultAutonomyMode);
  const base = defaultPolicyForAutonomyMode(allowedRoot, autonomyMode);

  return {
    ...base,
    ...patch,
    autonomy_mode: autonomyMode,
    allowed_root: allowedRoot,
    safe_command_patterns: patch?.safe_command_patterns ?? base.safe_command_patterns,
  };
}

function defaultPolicyForAutonomyMode(
  allowedRoot: string,
  autonomyMode: AutonomyMode,
): RepositoryPolicyValues {
  const base: RepositoryPolicyValues = {
    autonomy_mode: autonomyMode,
    allowed_root: allowedRoot,
    allow_read: true,
    allow_edit: false,
    allow_bash: false,
    allow_git_write: false,
    allow_pr_create: false,
    safe_command_patterns: ["^git status$", "^vp test$", "^vp check$"],
    approval_required_for_edit: true,
    approval_required_for_commit: true,
    approval_required_for_pr: true,
    approval_required_for_risky_bash: true,
    cheap_provider: "openai",
    cheap_model: "gpt-5-mini",
    strong_provider: "openai",
    strong_model: "gpt-5.4",
    classifier_provider: "openai",
    classifier_model: "gpt-5-mini",
    max_escalations: 1,
    max_task_budget_usd: 10,
  };

  switch (autonomyMode) {
    case "read-only":
      return base;
    case "approve-writes":
      return {
        ...base,
        allow_edit: true,
        allow_bash: true,
      };
    case "approve-commits":
      return {
        ...base,
        allow_edit: true,
        allow_bash: true,
        allow_git_write: true,
      };
    case "trusted":
      return {
        ...base,
        allow_edit: true,
        allow_bash: true,
        allow_git_write: true,
        allow_pr_create: true,
        approval_required_for_edit: false,
        approval_required_for_commit: false,
        approval_required_for_pr: false,
        approval_required_for_risky_bash: false,
      };
  }
}

function matchRepositoryDetail(pathname: string) {
  const match = /^\/api\/repos\/([^/]+)$/.exec(pathname);

  return match ? { repoId: decodeURIComponent(match[1] ?? "") } : null;
}

function matchRepositoryPolicy(pathname: string) {
  const match = /^\/api\/repos\/([^/]+)\/policy$/.exec(pathname);

  return match ? { repoId: decodeURIComponent(match[1] ?? "") } : null;
}

function matchTaskDetail(pathname: string) {
  const match = /^\/api\/tasks\/([^/]+)$/.exec(pathname);

  return match ? { taskId: decodeURIComponent(match[1] ?? "") } : null;
}

function matchTaskRetry(pathname: string) {
  const match = /^\/api\/tasks\/([^/]+)\/retry$/.exec(pathname);

  return match ? { taskId: decodeURIComponent(match[1] ?? "") } : null;
}

function matchTaskDiff(pathname: string) {
  const match = /^\/api\/tasks\/([^/]+)\/diff$/.exec(pathname);

  return match ? { taskId: decodeURIComponent(match[1] ?? "") } : null;
}

function matchTaskCommit(pathname: string) {
  const match = /^\/api\/tasks\/([^/]+)\/commit$/.exec(pathname);

  return match ? { taskId: decodeURIComponent(match[1] ?? "") } : null;
}

function matchTaskPullRequest(pathname: string) {
  const match = /^\/api\/tasks\/([^/]+)\/pr$/.exec(pathname);

  return match ? { taskId: decodeURIComponent(match[1] ?? "") } : null;
}

function matchApprovalApprove(pathname: string) {
  const match = /^\/api\/approvals\/([^/]+)\/approve$/.exec(pathname);

  return match ? { approvalId: decodeURIComponent(match[1] ?? "") } : null;
}

function matchApprovalReject(pathname: string) {
  const match = /^\/api\/approvals\/([^/]+)\/reject$/.exec(pathname);

  return match ? { approvalId: decodeURIComponent(match[1] ?? "") } : null;
}

async function readJsonBody(request: Request) {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}

function jsonResponse(request: Request, config: ServerConfig, status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(request, config),
    },
  });
}

function corsHeaders(request: Request, config: ServerConfig) {
  if (!isAllowedOrigin(request, config)) {
    return {};
  }

  const origin = request.headers.get("origin");

  return {
    "access-control-allow-origin": origin ?? new URL(request.url).origin,
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function isAllowedOrigin(request: Request, config: ServerConfig) {
  const origin = request.headers.get("origin");

  if (!origin) {
    return true;
  }

  const sameOrigin = origin === new URL(request.url).origin;

  return sameOrigin || config.allowed_origins.includes(origin);
}

function isRegisterRepositoryBody(value: unknown): value is RegisterRepositoryBody {
  return isObject(value) && typeof value.root_path === "string";
}

function isCreateTaskBody(value: unknown): value is CreateTaskBody {
  return (
    isObject(value) &&
    typeof value.repo_id === "string" &&
    typeof value.user_prompt === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.goal_type === undefined || typeof value.goal_type === "string") &&
    (value.expected_file_count === undefined || typeof value.expected_file_count === "number")
  );
}

function isCommitTaskBody(value: unknown): value is CommitTaskBody {
  return isObject(value) && (value.message === undefined || typeof value.message === "string");
}

function isCreatePullRequestBody(value: unknown): value is CreatePullRequestBody {
  return (
    isObject(value) &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.body === undefined || typeof value.body === "string")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApprovalDecisionBody(value: unknown): value is ApprovalDecisionBody {
  return (
    isObject(value) &&
    (value.decided_by === undefined || typeof value.decided_by === "string") &&
    (value.scope === undefined || typeof value.scope === "string")
  );
}

function normalizePolicyPatch(value: Record<string, unknown>): PolicyPatch {
  const patch: PolicyPatch = {};

  for (const [key, rawValue] of Object.entries(value)) {
    if (key === "autonomy_mode") {
      if (typeof rawValue !== "string") {
        throw new Error("autonomy_mode must be a string.");
      }

      patch.autonomy_mode = toAutonomyMode(rawValue);
      continue;
    }

    if (key === "allowed_root") {
      if (typeof rawValue !== "string") {
        throw new Error("allowed_root must be a string.");
      }

      patch.allowed_root = rawValue;
      continue;
    }

    if (key === "safe_command_patterns") {
      if (!Array.isArray(rawValue) || rawValue.some((entry) => typeof entry !== "string")) {
        throw new Error("safe_command_patterns must be an array of strings.");
      }

      patch.safe_command_patterns = rawValue;
      continue;
    }

    if ((booleanPolicyKeys as readonly string[]).includes(key)) {
      if (typeof rawValue !== "boolean") {
        throw new Error(`${key} must be a boolean.`);
      }

      patch[key as (typeof booleanPolicyKeys)[number]] = rawValue;
      continue;
    }

    if ((stringPolicyKeys as readonly string[]).includes(key)) {
      if (typeof rawValue !== "string") {
        throw new Error(`${key} must be a string.`);
      }

      patch[key as (typeof stringPolicyKeys)[number]] = rawValue;
      continue;
    }

    if ((nullableStringPolicyKeys as readonly string[]).includes(key)) {
      if (rawValue !== null && typeof rawValue !== "string") {
        throw new Error(`${key} must be a string or null.`);
      }

      patch[key as (typeof nullableStringPolicyKeys)[number]] = rawValue;
      continue;
    }

    if ((numberPolicyKeys as readonly string[]).includes(key)) {
      if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
        throw new Error(`${key} must be a number.`);
      }

      if (key === "max_escalations" && (!Number.isInteger(rawValue) || rawValue < 0)) {
        throw new Error("max_escalations must be a non-negative integer.");
      }

      if (key === "max_task_budget_usd" && rawValue < 0) {
        throw new Error("max_task_budget_usd must be greater than or equal to 0.");
      }

      patch[key as (typeof numberPolicyKeys)[number]] = rawValue;
      continue;
    }

    throw new Error(`Unsupported policy field '${key}'.`);
  }

  return patch;
}

function resolveTaskGoalType(
  value: string | undefined,
  prompt: string,
  title: string | undefined,
): TaskGoalType | undefined {
  if (value) {
    return toTaskGoalType(value);
  }

  const haystack = `${title ?? ""} ${prompt}`.toLowerCase();

  if (haystack.includes("refactor")) {
    return "refactor";
  }

  if (haystack.includes("debug") || haystack.includes("investigate")) {
    return "debug";
  }

  if (haystack.includes("fix") || haystack.includes("bug")) {
    return "fix";
  }

  if (haystack.includes("plan") || haystack.includes("approach")) {
    return "plan";
  }

  if (
    haystack.includes("implement") ||
    haystack.includes("add") ||
    haystack.includes("create") ||
    haystack.includes("wire")
  ) {
    return "implement";
  }

  if (
    haystack.includes("explain") ||
    haystack.includes("summarize") ||
    haystack.includes("what does") ||
    haystack.includes("show me")
  ) {
    return "question";
  }

  return undefined;
}

function normalizeTaskTitle(title: string | undefined, userPrompt: string) {
  const trimmedTitle = title?.trim();

  if (trimmedTitle) {
    return trimmedTitle;
  }

  const trimmedPrompt = userPrompt.trim();

  if (!trimmedPrompt) {
    throw new Error("user_prompt must not be empty.");
  }

  return trimmedPrompt.length <= 72 ? trimmedPrompt : `${trimmedPrompt.slice(0, 69).trimEnd()}...`;
}

async function maybeExecuteTask(
  database: ReturnType<typeof bootstrapControlPlaneDatabase>,
  config: ServerConfig,
  taskId: string,
  executionReason: "start" | "retry" | "resume" = "start",
  piRuntime?: PiRunnerRuntime,
) {
  const context = getTaskExecutionContext(database, taskId);

  if (!context) {
    throw new Error(`Task '${taskId}' was not found for execution.`);
  }

  const readDecision = evaluatePolicyAction(context.policy, { kind: "read" });

  if (!readDecision.allowed) {
    updateTaskExecution(database, taskId, {
      status: "failed",
      pi_session_id: context.task.pi_session_id,
      branch_name: context.task.branch_name,
      started_at: context.task.started_at,
      completed_at: new Date().toISOString(),
    });
    recordAuditEvent(
      database,
      context.repository.id,
      context.task.id,
      "task.execution.blocked",
      readDecision.reason,
      {
        action: "read",
      },
    );

    const detail = getTaskDetail(database, taskId);

    if (!detail) {
      throw new Error(`Task '${taskId}' disappeared after read access was denied.`);
    }

    return detail;
  }

  const approvalRequirement = getApprovalRequirement(context.task.goal_type);

  if (approvalRequirement) {
    const approvalDecision = evaluatePolicyAction(context.policy, {
      kind: approvalRequirement.action,
    });

    if (!approvalDecision.allowed) {
      updateTaskExecution(database, taskId, {
        status: "failed",
        pi_session_id: context.task.pi_session_id,
        branch_name: context.task.branch_name,
        started_at: context.task.started_at,
        completed_at: new Date().toISOString(),
      });
      recordAuditEvent(
        database,
        context.repository.id,
        context.task.id,
        "task.execution.blocked",
        approvalDecision.reason,
        {
          action: approvalRequirement.action,
        },
      );

      const detail = getTaskDetail(database, taskId);

      if (!detail) {
        throw new Error(`Task '${taskId}' disappeared after approval-gated access was denied.`);
      }

      return detail;
    }

    if (approvalDecision.requires_approval) {
      const approvedApproval = getLatestApprovedTaskApproval(
        database,
        taskId,
        approvalRequirement.approval_type,
      );

      if (!approvedApproval) {
        const pendingApproval = getPendingTaskApproval(
          database,
          taskId,
          approvalRequirement.approval_type,
        );

        if (!pendingApproval) {
          const approval = createApproval(database, {
            task_id: taskId,
            approval_type: approvalRequirement.approval_type,
            requested_action: approvalRequirement.requested_action,
            requested_payload_json: JSON.stringify({
              repo_id: context.repository.id,
              repo_name: context.repository.name,
              task_id: context.task.id,
              task_title: context.task.title,
              goal_type: context.task.goal_type,
              routing_tier: context.task.routing_tier,
            }),
          });

          if (!approval) {
            throw new Error(`Task '${taskId}' could not create its approval checkpoint.`);
          }

          recordAuditEvent(
            database,
            context.repository.id,
            context.task.id,
            "task.approval.requested",
            "Task execution paused for an approval-gated action.",
            {
              approval_id: approval.id,
              approval_type: approval.approval_type,
              action: approvalRequirement.action,
            },
          );
        }

        updateTaskExecution(database, taskId, {
          status: "awaiting_approval",
          pi_session_id: context.task.pi_session_id,
          branch_name: context.task.branch_name,
          started_at: context.task.started_at,
          completed_at: null,
        });

        const detail = getTaskDetail(database, taskId);

        if (!detail) {
          throw new Error(`Task '${taskId}' disappeared while waiting for approval.`);
        }

        return detail;
      }
    }
  }

  const startedAt =
    executionReason === "resume" && context.task.started_at
      ? context.task.started_at
      : new Date().toISOString();
  const activeBranchName = requiresTaskBranch(context.task.goal_type)
    ? ensureTaskBranchForTask(context)
    : context.task.branch_name;
  const claimedExecution = claimTaskExecution(
    database,
    taskId,
    executionStartStatusesForReason(executionReason),
    {
      status: "running",
      pi_session_id: context.task.pi_session_id,
      branch_name: activeBranchName,
      started_at: startedAt,
      completed_at: null,
    },
  );

  if (!claimedExecution) {
    const detail = getTaskDetail(database, taskId);

    if (!detail) {
      throw new Error(`Task '${taskId}' disappeared while another request claimed execution.`);
    }

    return detail;
  }

  recordAuditEvent(
    database,
    context.repository.id,
    context.task.id,
    executionReason === "retry"
      ? "task.execution.retried"
      : executionReason === "resume"
        ? "task.execution.resumed"
        : "task.execution.started",
    executionReason === "retry"
      ? "Retried task execution through the pi runner."
      : executionReason === "resume"
        ? "Resumed task execution after approval."
        : "Started task execution through the pi runner.",
    {
      goal_type: context.task.goal_type,
      routing_tier: context.task.routing_tier,
    },
  );

  try {
    const executionRequest = buildPiExecutionRequest(config, context, startedAt);
    const result = await executePiTask(
      executionRequest,
      buildPiRunnerRuntime(database, context, startedAt, piRuntime),
    );

    replaceTaskArtifacts(
      database,
      taskId,
      result.artifacts.map((artifact) => ({
        artifact_type: artifact.artifact_type,
        summary: artifact.summary,
        payload_json: JSON.stringify(artifact.payload),
      })),
    );
    updateTaskExecution(database, taskId, {
      status: "completed",
      pi_session_id: result.session_id,
      branch_name: activeBranchName,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });
    recordAuditEvent(
      database,
      context.repository.id,
      context.task.id,
      "task.execution.completed",
      "Persisted pi session reference and execution artifacts.",
      {
        session_id: result.session_id,
        session_key: result.session_key,
        artifact_count: result.artifacts.length,
      },
    );
  } catch (error) {
    if (error instanceof PiCommandApprovalRequiredError) {
      const pendingApproval = getPendingTaskApproval(database, taskId, error.approval_type);

      if (!pendingApproval) {
        const approval = createApproval(database, {
          task_id: taskId,
          approval_type: error.approval_type,
          requested_action: error.requested_action,
          requested_payload_json: JSON.stringify(error.requested_payload),
        });

        if (!approval) {
          throw new Error(`Task '${taskId}' could not create its risky bash approval.`);
        }

        recordAuditEvent(
          database,
          context.repository.id,
          context.task.id,
          "task.approval.requested",
          "Task execution paused for a risky bash command approval.",
          {
            approval_id: approval.id,
            approval_type: approval.approval_type,
            action: "bash",
            command_fingerprint:
              typeof error.requested_payload.command_fingerprint === "string"
                ? error.requested_payload.command_fingerprint
                : null,
          },
        );
      }

      updateTaskExecution(database, taskId, {
        status: "awaiting_approval",
        pi_session_id: context.task.pi_session_id,
        branch_name: activeBranchName,
        started_at: startedAt,
        completed_at: null,
      });

      const detail = getTaskDetail(database, taskId);

      if (!detail) {
        throw new Error(`Task '${taskId}' disappeared while waiting for risky bash approval.`);
      }

      return detail;
    }

    if (error instanceof PiExecutionBlockedError) {
      updateTaskExecution(database, taskId, {
        status: "failed",
        pi_session_id: context.task.pi_session_id,
        branch_name: activeBranchName,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      recordAuditEvent(
        database,
        context.repository.id,
        context.task.id,
        "task.execution.blocked",
        error.message,
        {
          action: error.action,
        },
      );

      const detail = getTaskDetail(database, taskId);

      if (!detail) {
        throw new Error(`Task '${taskId}' disappeared after bash access was denied.`);
      }

      return detail;
    }

    updateTaskExecution(database, taskId, {
      status: "failed",
      pi_session_id: context.task.pi_session_id,
      branch_name: activeBranchName,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });
    recordAuditEvent(
      database,
      context.repository.id,
      context.task.id,
      "task.execution.failed",
      error instanceof Error ? error.message : "Task execution failed.",
      {
        goal_type: context.task.goal_type,
        routing_tier: context.task.routing_tier,
      },
    );
  }

  const detail = getTaskDetail(database, taskId);

  if (!detail) {
    throw new Error(`Task '${taskId}' was not available after execution.`);
  }

  return detail;
}

function buildPiExecutionRequest(
  config: ServerConfig,
  context: NonNullable<ReturnType<typeof getTaskExecutionContext>>,
  startedAt: string,
): PiExecutionRequest {
  return {
    mode: config.pi_runner_mode,
    execution_key: buildTaskExecutionKey(context.task.id, startedAt),
    repo: {
      id: context.repository.id,
      name: context.repository.name,
      root_path: context.repository.root_path,
      default_branch: context.repository.default_branch,
    },
    policy: {
      allowed_root: context.policy.allowed_root,
      autonomy_mode: context.policy.autonomy_mode,
      allow_read: context.policy.allow_read,
      allow_edit: context.policy.allow_edit,
      allow_bash: context.policy.allow_bash,
      approval_required_for_risky_bash: context.policy.approval_required_for_risky_bash,
      max_task_budget_usd: context.policy.max_task_budget_usd,
    },
    task: {
      id: context.task.id,
      title: context.task.title,
      user_prompt: context.task.user_prompt,
      goal_type: context.task.goal_type,
    },
    routing_tier: context.task.routing_tier ?? "strong",
    model_profile:
      context.task.routing_tier === "cheap"
        ? {
            provider: context.policy.cheap_provider,
            model: context.policy.cheap_model,
          }
        : {
            provider: context.policy.strong_provider,
            model: context.policy.strong_model,
          },
  };
}

function buildPiRunnerRuntime(
  database: ReturnType<typeof bootstrapControlPlaneDatabase>,
  context: NonNullable<ReturnType<typeof getTaskExecutionContext>>,
  startedAt: string,
  runtime?: PiRunnerRuntime,
): PiRunnerRuntime {
  const sessionKey = buildTaskExecutionKey(context.task.id, startedAt);

  return {
    ...runtime,
    authorizeBashCommand({ command }) {
      const decision = evaluatePolicyAction(context.policy, { kind: "bash", command });

      if (!decision.allowed) {
        return {
          status: "deny" as const,
          reason: decision.reason,
        };
      }

      if (!decision.requires_approval) {
        return {
          status: "allow" as const,
          scope: null,
        };
      }

      const commandFingerprint = fingerprintCommand(command);
      const grant = findReusableRiskyBashGrant(database, {
        repo_id: context.repository.id,
        task_id: context.task.id,
        session_key: sessionKey,
        command_fingerprint: commandFingerprint,
      });

      if (!grant) {
        return {
          status: "require_approval" as const,
          requested_action: "Allow the risky bash command for this task.",
          payload: {
            repo_id: context.repository.id,
            repo_name: context.repository.name,
            task_id: context.task.id,
            task_title: context.task.title,
            goal_type: context.task.goal_type,
            routing_tier: context.task.routing_tier,
            command,
            command_fingerprint: commandFingerprint,
            session_key: sessionKey,
          } satisfies RiskyBashApprovalRequestPayload,
        };
      }

      if (grant.scope === "once") {
        const consumed = consumeRiskyBashGrant(database, grant.id, new Date().toISOString());

        if (!consumed) {
          return {
            status: "require_approval" as const,
            requested_action: "Allow the risky bash command for this task.",
            payload: {
              repo_id: context.repository.id,
              repo_name: context.repository.name,
              task_id: context.task.id,
              task_title: context.task.title,
              goal_type: context.task.goal_type,
              routing_tier: context.task.routing_tier,
              command,
              command_fingerprint: commandFingerprint,
              session_key: sessionKey,
            } satisfies RiskyBashApprovalRequestPayload,
          };
        }
      }

      return {
        status: "allow" as const,
        scope: grant.scope,
      };
    },
  };
}

function getTaskDiff(
  database: ReturnType<typeof bootstrapControlPlaneDatabase>,
  taskId: string,
): TaskDiffResponse | null {
  const context = getTaskExecutionContext(database, taskId);

  if (!context) {
    return null;
  }

  return collectTaskDiff(context);
}

function executeTaskOperatorAction(
  database: ReturnType<typeof bootstrapControlPlaneDatabase>,
  taskId: string,
  action: OperatorActionKind,
  body: CommitTaskBody | CreatePullRequestBody,
): TaskActionResponse {
  const context = getTaskExecutionContext(database, taskId);

  if (!context) {
    throw new Error(`Task '${taskId}' was not found.`);
  }

  assertTaskReadyForOperatorAction(context.task.status, action);

  if (!requiresTaskBranch(context.task.goal_type)) {
    throw new Error(`Task '${taskId}' does not produce a task branch for ${action}.`);
  }

  const branchName = ensureTaskBranchForTask(context);

  if (action === "commit") {
    const commitMessage =
      normalizeOptionalText((body as CommitTaskBody).message) ?? defaultCommitMessage(context);
    const decision = evaluatePolicyAction(context.policy, { kind: "git_write" });

    if (!decision.allowed) {
      recordAuditEvent(
        database,
        context.repository.id,
        context.task.id,
        "task.git.blocked",
        decision.reason,
        {
          action,
          branch_name: branchName,
        },
      );
      throw new Error(decision.reason);
    }

    if (decision.requires_approval) {
      return requestOperatorApproval(database, context, "commit", {
        branch_name: branchName,
        commit_message: commitMessage,
        pr_body: null,
        pr_title: null,
      });
    }

    return {
      approval: null,
      task: performTaskCommit(database, context, branchName, commitMessage),
    };
  }

  const prTitle = normalizeOptionalText((body as CreatePullRequestBody).title);
  const prBody = normalizeOptionalText((body as CreatePullRequestBody).body);
  const decision = evaluatePolicyAction(context.policy, { kind: "pull_request" });

  if (!decision.allowed) {
    recordAuditEvent(
      database,
      context.repository.id,
      context.task.id,
      "task.git.blocked",
      decision.reason,
      {
        action,
        branch_name: branchName,
      },
    );
    throw new Error(decision.reason);
  }

  if (decision.requires_approval) {
    return requestOperatorApproval(database, context, "pull_request", {
      branch_name: branchName,
      commit_message: null,
      pr_body: prBody,
      pr_title: prTitle,
    });
  }

  return {
    approval: null,
    task: performTaskPullRequestDraft(database, context, branchName, {
      title: prTitle,
      body: prBody,
    }),
  };
}

function executeApprovedOperatorAction(
  database: ReturnType<typeof bootstrapControlPlaneDatabase>,
  taskId: string,
  payload: OperatorActionRequestPayload,
) {
  const context = getTaskExecutionContext(database, taskId);

  if (!context) {
    throw new Error(`Task '${taskId}' was not found for the approved operator action.`);
  }

  const branchName = ensureTaskBranchForTask(context);

  switch (payload.operator_action) {
    case "commit":
      return performTaskCommit(
        database,
        context,
        branchName,
        payload.commit_message ?? defaultCommitMessage(context),
      );
    case "pull_request":
      return performTaskPullRequestDraft(database, context, branchName, {
        title: payload.pr_title,
        body: payload.pr_body,
      });
  }
}

function requestOperatorApproval(
  database: ReturnType<typeof bootstrapControlPlaneDatabase>,
  context: NonNullable<ReturnType<typeof getTaskExecutionContext>>,
  action: OperatorActionKind,
  payload: Pick<
    OperatorActionRequestPayload,
    "branch_name" | "commit_message" | "pr_body" | "pr_title"
  >,
): TaskActionResponse {
  const existingApproval = getPendingTaskApproval(
    database,
    context.task.id,
    action === "commit" ? "commit" : "pull_request",
  );

  if (existingApproval) {
    const detail = getTaskDetail(database, context.task.id);

    if (!detail) {
      throw new Error(`Task '${context.task.id}' disappeared while waiting for approval.`);
    }

    return {
      approval: existingApproval,
      task: detail,
    };
  }

  const approval = createApproval(database, {
    task_id: context.task.id,
    approval_type: action === "commit" ? "commit" : "pull_request",
    requested_action:
      action === "commit"
        ? "Approve committing the task branch."
        : "Approve generating a pull request draft for the task branch.",
    requested_payload_json: JSON.stringify({
      approval_flow: "operator_action",
      operator_action: action,
      repo_id: context.repository.id,
      repo_name: context.repository.name,
      task_id: context.task.id,
      task_title: context.task.title,
      goal_type: context.task.goal_type,
      routing_tier: context.task.routing_tier,
      branch_name: payload.branch_name,
      commit_message: payload.commit_message,
      pr_title: payload.pr_title,
      pr_body: payload.pr_body,
    } satisfies OperatorActionRequestPayload),
  });

  if (!approval) {
    throw new Error(`Task '${context.task.id}' could not create its ${action} approval.`);
  }

  recordAuditEvent(
    database,
    context.repository.id,
    context.task.id,
    "task.approval.requested",
    action === "commit"
      ? "Task commit is waiting for operator approval."
      : "Pull request draft generation is waiting for operator approval.",
    {
      approval_id: approval.id,
      approval_type: approval.approval_type,
      operator_action: action,
      branch_name: payload.branch_name,
    },
  );

  const detail = getTaskDetail(database, context.task.id);

  if (!detail) {
    throw new Error(`Task '${context.task.id}' disappeared while creating its approval.`);
  }

  return {
    approval,
    task: detail,
  };
}

function performTaskCommit(
  database: ReturnType<typeof bootstrapControlPlaneDatabase>,
  context: NonNullable<ReturnType<typeof getTaskExecutionContext>>,
  branchName: string,
  commitMessage: string,
) {
  const pathspec = taskPathspec(context);
  const diff = collectTaskDiff(context);

  if (!diff.has_changes) {
    throw new Error("No task changes are available to commit.");
  }

  runGit(context.repository.root_path, ["add", "--", pathspec]);
  runGit(context.repository.root_path, ["commit", "-m", commitMessage, "--", pathspec]);

  const commitSha =
    runGit(context.repository.root_path, ["rev-parse", "--short", "HEAD"])?.trim() ?? "unknown";
  const committedAt = new Date().toISOString();

  upsertTaskArtifacts(database, context.task.id, [
    {
      artifact_type: "commit_metadata",
      summary: `Committed ${branchName} at ${commitSha}.`,
      payload_json: JSON.stringify({
        branch_name: branchName,
        committed_at: committedAt,
        message: commitMessage,
        sha: commitSha,
      }),
    },
  ]);
  recordAuditEvent(
    database,
    context.repository.id,
    context.task.id,
    "task.git.committed",
    "Committed task branch changes.",
    {
      branch_name: branchName,
      commit_sha: commitSha,
      message: commitMessage,
    },
  );

  const detail = getTaskDetail(database, context.task.id);

  if (!detail) {
    throw new Error(`Task '${context.task.id}' was not available after committing changes.`);
  }

  return detail;
}

function performTaskPullRequestDraft(
  database: ReturnType<typeof bootstrapControlPlaneDatabase>,
  context: NonNullable<ReturnType<typeof getTaskExecutionContext>>,
  branchName: string,
  overrides: { title: string | null; body: string | null },
) {
  const diff = collectTaskDiff(context);

  if (diff.has_changes) {
    throw new Error("Commit the current task changes before creating a pull request draft.");
  }

  const detail = getTaskDetail(database, context.task.id);

  if (!detail) {
    throw new Error(`Task '${context.task.id}' was not available while drafting the pull request.`);
  }

  const draft = buildPullRequestDraft({
    task: {
      title: context.task.title,
      routing_reason: context.task.routing_reason,
      branch_name: branchName,
    },
    base_branch: context.repository.default_branch,
    artifact_summaries: detail.artifacts.map((artifact) => artifact.summary),
  });
  const title = overrides.title ?? draft.title;
  const body = overrides.body ?? draft.body;
  const headSha =
    runGit(context.repository.root_path, ["rev-parse", "--short", "HEAD"])?.trim() ?? "unknown";
  const compareUrl =
    context.repository.github_owner && context.repository.github_repo
      ? `https://github.com/${context.repository.github_owner}/${context.repository.github_repo}/compare/${encodeURIComponent(draft.base_branch)}...${encodeURIComponent(draft.head_branch)}?expand=1`
      : null;

  upsertTaskArtifacts(database, context.task.id, [
    {
      artifact_type: "pr_metadata",
      summary: `Prepared a PR draft from ${draft.head_branch} into ${draft.base_branch}.`,
      payload_json: JSON.stringify({
        base_branch: draft.base_branch,
        body,
        compare_url: compareUrl,
        head_branch: draft.head_branch,
        head_sha: headSha,
        remote_url: context.repository.remote_url,
        status: "drafted",
        title,
      }),
    },
  ]);
  recordAuditEvent(
    database,
    context.repository.id,
    context.task.id,
    "task.git.pr_drafted",
    "Prepared a pull request draft from the task branch.",
    {
      base_branch: draft.base_branch,
      branch_name: draft.head_branch,
      compare_url: compareUrl,
      head_sha: headSha,
    },
  );

  const nextDetail = getTaskDetail(database, context.task.id);

  if (!nextDetail) {
    throw new Error(`Task '${context.task.id}' was not available after drafting the pull request.`);
  }

  return nextDetail;
}

function collectTaskDiff(
  context: NonNullable<ReturnType<typeof getTaskExecutionContext>>,
): TaskDiffResponse {
  const pathspec = taskPathspec(context);
  const currentBranch = currentGitBranch(context.repository.root_path);
  const headSha =
    runGit(context.repository.root_path, ["rev-parse", "--short", "HEAD"], false)?.trim() ?? null;
  const statusOutput =
    runGit(
      context.repository.root_path,
      ["status", "--short", "--untracked-files=all", "--", pathspec],
      false,
    ) ?? "";
  const diffStat =
    runGit(context.repository.root_path, ["diff", "--stat", "--", pathspec], false)?.trim() ?? "";
  const patch =
    runGit(context.repository.root_path, ["diff", "--no-color", "--", pathspec], false)?.trim() ??
    "";
  const { aheadBy, behindBy } =
    context.task.branch_name === null
      ? { aheadBy: 0, behindBy: 0 }
      : branchDistance(
          context.repository.root_path,
          context.repository.default_branch,
          context.task.branch_name,
        );
  const changedFiles = parseGitStatusLines(statusOutput);

  return {
    base_branch: context.repository.default_branch,
    branch_name: context.task.branch_name,
    current_branch: currentBranch,
    head_sha: headSha,
    ahead_by: aheadBy,
    behind_by: behindBy,
    has_changes: changedFiles.length > 0,
    changed_files: changedFiles,
    diff_stat: diffStat,
    patch,
  };
}

function requiresTaskBranch(goalType: TaskGoalType) {
  return goalType !== "question" && goalType !== "plan";
}

function ensureTaskBranchForTask(context: NonNullable<ReturnType<typeof getTaskExecutionContext>>) {
  const branchName =
    context.task.branch_name ?? buildTaskBranchName(context.task.id, context.task.title);
  const currentBranch = currentGitBranch(context.repository.root_path);

  if (currentBranch === branchName) {
    return branchName;
  }

  if (hasLocalBranch(context.repository.root_path, branchName)) {
    runGit(context.repository.root_path, ["checkout", branchName]);
    return branchName;
  }

  if (currentBranch !== context.repository.default_branch) {
    runGit(context.repository.root_path, ["checkout", context.repository.default_branch]);
  }

  runGit(context.repository.root_path, ["checkout", "-b", branchName]);

  return branchName;
}

function hasLocalBranch(rootPath: string, branchName: string) {
  return (
    runGit(rootPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], false) !==
    null
  );
}

function currentGitBranch(rootPath: string) {
  const branch = runGit(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"], false)?.trim();

  return branch && branch !== "HEAD" ? branch : null;
}

function branchDistance(rootPath: string, baseBranch: string, branchName: string) {
  const output =
    runGit(
      rootPath,
      ["rev-list", "--left-right", "--count", `${baseBranch}...${branchName}`],
      false,
    )?.trim() ?? "";
  const [behindRaw, aheadRaw] = output.split(/\s+/);

  return {
    aheadBy: Number.parseInt(aheadRaw ?? "0", 10) || 0,
    behindBy: Number.parseInt(behindRaw ?? "0", 10) || 0,
  };
}

function taskPathspec(context: NonNullable<ReturnType<typeof getTaskExecutionContext>>) {
  const relativeRoot = relativePath(context.repository.root_path, context.policy.allowed_root);

  return relativeRoot.length === 0 ? "." : relativeRoot;
}

function parseGitStatusLines(output: string) {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => ({
      status: line.slice(0, 2).trim() || "modified",
      path: line.slice(3).trim(),
    }));
}

function buildTaskBranchName(taskId: string, taskTitle: string) {
  const slug = taskTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return `task/${slug || "task"}-${taskId.slice(0, 8)}`;
}

function defaultCommitMessage(context: NonNullable<ReturnType<typeof getTaskExecutionContext>>) {
  return `Task: ${context.task.title}`;
}

function normalizeOptionalText(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function assertTaskReadyForOperatorAction(
  status: NonNullable<ReturnType<typeof getTaskExecutionContext>>["task"]["status"],
  action: OperatorActionKind,
) {
  if (status === "queued" || status === "running" || status === "awaiting_approval") {
    throw new Error(`Task ${action} is unavailable while the task status is '${status}'.`);
  }
}

function isImmediateChild(parentRoot: string, childRoot: string) {
  return dirname(childRoot) === parentRoot;
}

function assertAllowedRootWithinRepo(repoRoot: string, allowedRoot: string) {
  const normalizedRepoRoot = realpathSync(repoRoot);
  const normalizedAllowedRoot = realpathSync(resolvePath(normalizedRepoRoot, allowedRoot));

  if (
    normalizedAllowedRoot !== normalizedRepoRoot &&
    !normalizedAllowedRoot.startsWith(`${normalizedRepoRoot}${sep}`)
  ) {
    throw new Error(
      `allowed_root '${normalizedAllowedRoot}' must stay inside '${normalizedRepoRoot}'.`,
    );
  }

  return normalizedAllowedRoot;
}

function runGit(rootPath: string, args: string[], shouldThrow = true) {
  const result = spawnSync("git", ["-C", rootPath, ...args], {
    encoding: "utf8",
  });

  if (result.status === 0) {
    return result.stdout;
  }

  if (shouldThrow) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed for '${rootPath}'.`);
  }

  return null;
}

function stripOriginPrefix(value: string | undefined) {
  return value?.startsWith("origin/") ? value.slice("origin/".length) : value;
}

function parseGithubRemote(remoteUrl: string | null) {
  if (!remoteUrl) {
    return null;
  }

  const match = /github\.com[:/]([^/]+)\/([^/]+)$/.exec(remoteUrl);

  if (!match) {
    return null;
  }

  const repo = (match[2] ?? "").replace(/\.git$/, "");

  return {
    owner: match[1] ?? null,
    repo: repo || null,
  };
}

function getApprovalRequirement(goalType: TaskGoalType) {
  if (goalType === "question" || goalType === "plan") {
    return null;
  }

  return {
    action: "edit" as const,
    approval_type: "edit" as const,
    requested_action: "Allow repository edits for this task.",
  };
}

function executionStartStatusesForReason(executionReason: "start" | "retry" | "resume") {
  switch (executionReason) {
    case "start":
      return ["queued"] as const;
    case "retry":
      return ["queued", "failed", "completed"] as const;
    case "resume":
      return ["awaiting_approval"] as const;
  }
}

function normalizeDecisionActor(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function toApprovalScope(value: string | undefined): ApprovalScope | null {
  if (!value) {
    return null;
  }

  return approvalScopes.includes(value as ApprovalScope) ? (value as ApprovalScope) : null;
}

function parseRiskyBashApprovalPayload(value: string): RiskyBashApprovalRequestPayload | null {
  try {
    const payload = JSON.parse(value) as Record<string, unknown>;

    if (
      typeof payload.repo_id !== "string" ||
      typeof payload.repo_name !== "string" ||
      typeof payload.task_id !== "string" ||
      typeof payload.task_title !== "string" ||
      typeof payload.goal_type !== "string" ||
      typeof payload.command !== "string" ||
      typeof payload.command_fingerprint !== "string" ||
      typeof payload.session_key !== "string"
    ) {
      return null;
    }

    return {
      repo_id: payload.repo_id,
      repo_name: payload.repo_name,
      task_id: payload.task_id,
      task_title: payload.task_title,
      goal_type: toTaskGoalType(payload.goal_type),
      routing_tier:
        payload.routing_tier === "cheap" || payload.routing_tier === "strong"
          ? payload.routing_tier
          : null,
      command: payload.command,
      command_fingerprint: payload.command_fingerprint,
      session_key: payload.session_key,
    };
  } catch {
    return null;
  }
}

function parseOperatorActionRequestPayload(value: string): OperatorActionRequestPayload | null {
  try {
    const payload = JSON.parse(value) as Record<string, unknown>;

    if (
      payload.approval_flow !== "operator_action" ||
      (payload.operator_action !== "commit" && payload.operator_action !== "pull_request") ||
      typeof payload.repo_id !== "string" ||
      typeof payload.repo_name !== "string" ||
      typeof payload.task_id !== "string" ||
      typeof payload.task_title !== "string" ||
      typeof payload.goal_type !== "string" ||
      typeof payload.branch_name !== "string"
    ) {
      return null;
    }

    return {
      approval_flow: "operator_action",
      operator_action: payload.operator_action,
      repo_id: payload.repo_id,
      repo_name: payload.repo_name,
      task_id: payload.task_id,
      task_title: payload.task_title,
      goal_type: toTaskGoalType(payload.goal_type),
      routing_tier:
        payload.routing_tier === "cheap" || payload.routing_tier === "strong"
          ? payload.routing_tier
          : null,
      branch_name: payload.branch_name,
      commit_message: typeof payload.commit_message === "string" ? payload.commit_message : null,
      pr_title: typeof payload.pr_title === "string" ? payload.pr_title : null,
      pr_body: typeof payload.pr_body === "string" ? payload.pr_body : null,
    };
  } catch {
    return null;
  }
}

function buildTaskExecutionKey(taskId: string, startedAt: string) {
  return `${taskId}:${startedAt}`;
}

function normalizeCommandForApproval(command: string) {
  return command.replaceAll("\r\n", "\n").trim();
}

function fingerprintCommand(command: string) {
  return createHash("sha256").update(normalizeCommandForApproval(command)).digest("hex");
}

function toAutonomyMode(value: string): AutonomyMode {
  if (autonomyModes.includes(value as AutonomyMode)) {
    return value as AutonomyMode;
  }

  throw new Error(`Autonomy mode '${value}' is not supported.`);
}

function toTaskGoalType(value: string): TaskGoalType {
  if (taskGoalTypes.includes(value as TaskGoalType)) {
    return value as TaskGoalType;
  }

  throw new Error(`Task goal type '${value}' is not supported.`);
}
