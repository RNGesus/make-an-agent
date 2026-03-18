import type {
  ApprovalRecord,
  ApprovalScope,
  AuditEventRecord,
  AutonomyMode,
  RepositoryPolicyRecord,
  RepositoryRecord,
  TaskArtifactRecord,
  TaskGoalType,
  TaskRecord,
} from "shared";

export type RepositoryDetail = {
  repository: RepositoryRecord;
  policy: RepositoryPolicyRecord;
};

export type TaskSummary = {
  task: TaskRecord;
  repository: Pick<RepositoryRecord, "default_branch" | "id" | "name">;
};

export type TaskDetail = TaskSummary & {
  approvals: ApprovalRecord[];
  artifacts: TaskArtifactRecord[];
  audit_events: AuditEventRecord[];
};

export type TaskDiff = {
  ahead_by: number;
  base_branch: string;
  behind_by: number;
  branch_name: string | null;
  changed_files: Array<{ path: string; status: string }>;
  current_branch: string | null;
  diff_stat: string;
  has_changes: boolean;
  head_sha: string | null;
  patch: string;
};

export type TaskActionResult = {
  approval: ApprovalRecord | null;
  task: TaskDetail;
};

export type RepositoryScanCandidate = {
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  is_registered: boolean;
  name: string;
  parent_source: string;
  registered_repo_id: string | null;
  remote_url: string | null;
  root_path: string;
};

export type WorkspaceScanResponse = {
  candidates: RepositoryScanCandidate[];
  parent_dir: string;
  warning: string | null;
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").trim();

export async function apiRequest<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);

  headers.set("accept", "application/json");

  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(resolveApiUrl(path), {
    ...init,
    headers,
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed with status ${response.status}.`);
  }

  return payload as T;
}

export function getApiTargetLabel() {
  return apiBaseUrl || "Same-origin /api proxy";
}

export function readArtifactText(artifacts: TaskArtifactRecord[], artifactType: string) {
  const payload = readArtifactValue<{ text?: string }>(artifacts, artifactType);

  return payload?.text ?? null;
}

export function readChangedFiles(artifacts: TaskArtifactRecord[]) {
  const payload = readArtifactValue<{ files?: Array<{ path: string; status: string }> }>(
    artifacts,
    "changed_files",
  );

  return payload?.files ?? [];
}

export function readArtifactValue<T>(artifacts: TaskArtifactRecord[], artifactType: string) {
  const artifact = artifacts.find((entry) => entry.artifact_type === artifactType);

  if (!artifact) {
    return null;
  }

  return readJsonValue<T>(artifact.payload_json);
}

export function readApprovalRequestMeta(approval: ApprovalRecord) {
  const payload = readJsonValue<Record<string, unknown>>(approval.requested_payload_json);

  return {
    command: typeof payload?.command === "string" ? payload.command : null,
    repo_name: typeof payload?.repo_name === "string" ? payload.repo_name : null,
    task_title: typeof payload?.task_title === "string" ? payload.task_title : null,
  };
}

export function readApprovalScope(approval: ApprovalRecord) {
  const payload = readJsonValue<{ scope?: ApprovalScope }>(approval.resolution_payload_json);

  return payload?.scope ?? null;
}

export function renderApprovalScopeLabel(scope: ApprovalScope) {
  switch (scope) {
    case "once":
      return "Accept Once";
    case "session":
      return "Accept For Session";
    case "global":
      return "Accept Globally";
  }
}

export function requireStringValue(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required.`);
  }

  return value.trim();
}

export function optionalStringValue(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

export function requireSelectValue(formData: FormData, key: string) {
  const value = optionalStringValue(formData, key);

  if (!value) {
    throw new Error(`${key} is required.`);
  }

  return value;
}

export function requireNumberValue(formData: FormData, key: string) {
  const value = requireStringValue(formData, key);
  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new Error(`${key} must be a number.`);
  }

  return parsed;
}

export function optionalNumberValue(formData: FormData, key: string) {
  const value = optionalStringValue(formData, key);

  if (value === null) {
    return null;
  }

  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new Error(`${key} must be a number.`);
  }

  return parsed;
}

export function readCheckbox(formData: FormData, name: string) {
  return formData.get(name) === "on";
}

export function toPolicyPayload(formData: FormData) {
  return {
    allow_bash: readCheckbox(formData, "allow_bash"),
    allow_edit: readCheckbox(formData, "allow_edit"),
    allow_git_write: readCheckbox(formData, "allow_git_write"),
    allow_pr_create: readCheckbox(formData, "allow_pr_create"),
    allow_read: readCheckbox(formData, "allow_read"),
    allowed_root: requireStringValue(formData, "allowed_root"),
    approval_required_for_commit: readCheckbox(formData, "approval_required_for_commit"),
    approval_required_for_edit: readCheckbox(formData, "approval_required_for_edit"),
    approval_required_for_pr: readCheckbox(formData, "approval_required_for_pr"),
    approval_required_for_risky_bash: readCheckbox(formData, "approval_required_for_risky_bash"),
    autonomy_mode: requireSelectValue(formData, "autonomy_mode") as AutonomyMode,
    cheap_model: requireStringValue(formData, "cheap_model"),
    cheap_provider: requireStringValue(formData, "cheap_provider"),
    classifier_model: optionalStringValue(formData, "classifier_model"),
    classifier_provider: optionalStringValue(formData, "classifier_provider"),
    max_escalations: requireNumberValue(formData, "max_escalations"),
    max_task_budget_usd: requireNumberValue(formData, "max_task_budget_usd"),
    strong_model: requireStringValue(formData, "strong_model"),
    strong_provider: requireStringValue(formData, "strong_provider"),
  };
}

export function toTaskPayload(formData: FormData, repoId: string) {
  const title = optionalStringValue(formData, "title");
  const goalType = optionalStringValue(formData, "goal_type") as TaskGoalType | null;
  const expectedFileCount = optionalNumberValue(formData, "expected_file_count");

  return {
    ...(expectedFileCount === null ? {} : { expected_file_count: expectedFileCount }),
    ...(goalType ? { goal_type: goalType } : {}),
    ...(title ? { title } : {}),
    repo_id: repoId,
    user_prompt: requireStringValue(formData, "user_prompt"),
  };
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong while talking to the control plane.";
}

function resolveApiUrl(path: string) {
  if (!apiBaseUrl) {
    return path;
  }

  return new URL(path, apiBaseUrl).toString();
}

function readJsonValue<T>(value: string) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
