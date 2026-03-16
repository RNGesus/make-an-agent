import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  bootstrapControlPlaneDatabase,
  createTask,
  getTaskDetail,
  getTaskExecutionContext,
  getRepositoryDetail,
  getRepositoryByRootPath,
  listTasks,
  listRepositories,
  recordAuditEvent,
  registerRepository,
  replaceTaskArtifacts,
  type RepositoryPolicyValues,
  updateTaskExecution,
  updateRepositoryPolicy,
} from "db/runtime";
import { evaluatePolicyAction } from "policy-engine";
import { autonomyModes, taskGoalTypes, type AutonomyMode, type TaskGoalType } from "shared";
import { resolveTaskRoute } from "task-router";
import { executePiTask, type PiExecutionRequest } from "pi-runner";
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

export function createServerApp(overrides: Partial<ServerConfig> = {}): ServerApp {
  const config: ServerConfig = {
    ...defaultServerConfig,
    ...overrides,
  };
  const database = bootstrapControlPlaneDatabase({ databasePath: config.database_path });

  return {
    config,
    async handleRequest(request) {
      return routeRequest(request, config, database);
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

      const executedTask = await maybeExecuteTask(database, config, task.task.id);

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

    const executedTask = await maybeExecuteTask(database, config, taskRetryMatch.taskId, true);

    return jsonResponse(request, config, 200, executedTask);
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  isRetry = false,
) {
  const context = getTaskExecutionContext(database, taskId);

  if (!context) {
    throw new Error(`Task '${taskId}' was not found for execution.`);
  }

  if (!canAutoExecuteTask(context.task.goal_type)) {
    recordAuditEvent(
      database,
      context.repository.id,
      context.task.id,
      isRetry ? "task.execution.retry_deferred" : "task.execution.deferred",
      "Execution is deferred until approval-backed write workflows land.",
      {
        goal_type: context.task.goal_type,
        routing_tier: context.task.routing_tier,
      },
    );

    const detail = getTaskDetail(database, taskId);

    if (!detail) {
      throw new Error(`Task '${taskId}' disappeared after deferring execution.`);
    }

    return detail;
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

  const startedAt = new Date().toISOString();
  updateTaskExecution(database, taskId, {
    status: "running",
    pi_session_id: context.task.pi_session_id,
    branch_name: context.task.branch_name,
    started_at: startedAt,
    completed_at: null,
  });
  recordAuditEvent(
    database,
    context.repository.id,
    context.task.id,
    isRetry ? "task.execution.retried" : "task.execution.started",
    isRetry
      ? "Retried task execution through the milestone-three runner."
      : "Started task execution through the milestone-three runner.",
    {
      goal_type: context.task.goal_type,
      routing_tier: context.task.routing_tier,
    },
  );

  try {
    const executionRequest = buildPiExecutionRequest(config, context);
    const result = await executePiTask(executionRequest);

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
      branch_name: context.task.branch_name,
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
    updateTaskExecution(database, taskId, {
      status: "failed",
      pi_session_id: context.task.pi_session_id,
      branch_name: context.task.branch_name,
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

function canAutoExecuteTask(goalType: TaskGoalType) {
  return goalType === "question" || goalType === "plan";
}

function buildPiExecutionRequest(
  config: ServerConfig,
  context: NonNullable<ReturnType<typeof getTaskExecutionContext>>,
): PiExecutionRequest {
  return {
    mode: config.pi_runner_mode,
    repo: {
      id: context.repository.id,
      name: context.repository.name,
      root_path: context.repository.root_path,
      default_branch: context.repository.default_branch,
    },
    policy: {
      allowed_root: context.policy.allowed_root,
      autonomy_mode: context.policy.autonomy_mode,
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
