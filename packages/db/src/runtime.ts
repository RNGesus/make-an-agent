import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  ArtifactType,
  AuditEventRecord,
  ApprovalRecord,
  ApprovalScope,
  ApprovalStatus,
  ApprovalType,
  RepositoryPolicyRecord,
  RepositoryRecord,
  RiskyBashGrantRecord,
  TaskArtifactRecord,
  TaskGoalType,
  TaskRecord,
} from "shared";
import { connectionPragmas } from "./index.ts";

const initialSchemaSql = readFileSync(
  new URL("../migrations/0001_initial_schema.sql", import.meta.url),
  "utf8",
);

interface RepositoryRow {
  id: string;
  name: string;
  root_path: string;
  parent_source: string;
  default_branch: string;
  remote_url: string | null;
  github_owner: string | null;
  github_repo: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface RepositoryPolicyRow {
  repo_id: string;
  autonomy_mode: RepositoryPolicyRecord["autonomy_mode"];
  allowed_root: string;
  allow_read: number;
  allow_edit: number;
  allow_bash: number;
  allow_git_write: number;
  allow_pr_create: number;
  safe_command_patterns_json: string;
  approval_required_for_edit: number;
  approval_required_for_commit: number;
  approval_required_for_pr: number;
  approval_required_for_risky_bash: number;
  cheap_provider: string;
  cheap_model: string;
  strong_provider: string;
  strong_model: string;
  classifier_provider: string | null;
  classifier_model: string | null;
  max_escalations: number;
  max_task_budget_usd: number;
}

interface TaskRow {
  id: string;
  repo_id: string;
  title: string;
  user_prompt: string;
  goal_type: TaskGoalType;
  status: TaskRecord["status"];
  routing_tier: TaskRecord["routing_tier"];
  routing_reason: string | null;
  classifier_score: number | null;
  classifier_confidence: number | null;
  pi_session_id: string | null;
  branch_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface TaskRepositoryRow {
  repository_id: string;
  repository_name: string;
  repository_default_branch: string;
}

interface TaskArtifactRow {
  id: string;
  task_id: string;
  artifact_type: ArtifactType;
  summary: string;
  payload_json: string;
  created_at: string;
}

interface AuditEventRow {
  id: string;
  repo_id: string | null;
  task_id: string | null;
  event_type: string;
  message: string;
  details_json: string;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  task_id: string;
  approval_type: ApprovalType;
  requested_action: string;
  requested_payload_json: string;
  resolution_payload_json: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

interface RiskyBashGrantRow {
  id: string;
  approval_id: string;
  repo_id: string;
  task_id: string | null;
  session_key: string | null;
  scope: ApprovalScope;
  command: string;
  command_fingerprint: string;
  decided_by: string | null;
  consumed_at: string | null;
  created_at: string;
}

export type RepositoryPolicyValues = Omit<RepositoryPolicyRecord, "repo_id">;

export interface RepositoryRegistrationInput {
  name: string;
  root_path: string;
  parent_source: string;
  default_branch: string;
  remote_url: string | null;
  github_owner: string | null;
  github_repo: string | null;
  policy: RepositoryPolicyValues;
}

export interface RepositoryDetail {
  repository: RepositoryRecord;
  policy: RepositoryPolicyRecord;
}

export interface TaskValues {
  repo_id: string;
  title: string;
  user_prompt: string;
  goal_type: TaskGoalType;
  status: TaskRecord["status"];
  routing_tier: TaskRecord["routing_tier"];
  routing_reason: string | null;
  classifier_score: number | null;
  classifier_confidence: number | null;
  pi_session_id: string | null;
  branch_name: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface TaskSummary {
  task: TaskRecord;
  repository: Pick<RepositoryRecord, "id" | "name" | "default_branch">;
}

export interface TaskDetail extends TaskSummary {
  artifacts: TaskArtifactRecord[];
  approvals: ApprovalRecord[];
  audit_events: AuditEventRecord[];
}

export interface TaskExecutionContext {
  task: TaskRecord;
  repository: RepositoryRecord;
  policy: RepositoryPolicyRecord;
}

export interface TaskArtifactValues {
  artifact_type: ArtifactType;
  summary: string;
  payload_json: string;
}

export interface ApprovalValues {
  task_id: string;
  approval_type: ApprovalType;
  requested_action: string;
  requested_payload_json: string;
}

export interface ApprovalResolutionValues {
  status: Extract<ApprovalStatus, "approved" | "rejected">;
  decided_by: string | null;
  decided_at: string;
  resolution_payload_json?: string;
}

export interface RiskyBashGrantValues {
  approval_id: string;
  repo_id: string;
  task_id: string | null;
  session_key: string | null;
  scope: ApprovalScope;
  command: string;
  command_fingerprint: string;
  decided_by: string | null;
}

export interface RiskyBashGrantLookup {
  repo_id: string;
  task_id: string;
  session_key: string;
  command_fingerprint: string;
}

export interface TaskExecutionValues {
  status: TaskRecord["status"];
  pi_session_id: string | null;
  branch_name: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface DatabaseBootstrapOptions {
  databasePath: string;
  cwd?: string;
}

export function resolveDatabasePath(databasePath: string, cwd = process.cwd()) {
  return isAbsolute(databasePath) ? databasePath : resolvePath(cwd, databasePath);
}

export function applyConnectionPragmas(database: DatabaseSync) {
  for (const pragma of connectionPragmas) {
    database.exec(pragma);
  }
}

export function applyInitialSchema(database: DatabaseSync) {
  database.exec(initialSchemaSql);
  ensureApprovalResolutionPayloadColumn(database);
}

export function bootstrapControlPlaneDatabase(options: DatabaseBootstrapOptions) {
  const filePath = resolveDatabasePath(options.databasePath, options.cwd);

  mkdirSync(dirname(filePath), { recursive: true });

  const database = new DatabaseSync(filePath);
  applyConnectionPragmas(database);
  applyInitialSchema(database);

  return database;
}

function ensureApprovalResolutionPayloadColumn(database: DatabaseSync) {
  const columns = database.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;

  if (columns.some((column) => column.name === "resolution_payload_json")) {
    return;
  }

  database.exec(
    "ALTER TABLE approvals ADD COLUMN resolution_payload_json TEXT NOT NULL DEFAULT '{}'",
  );
}

export function listRepositories(database: DatabaseSync) {
  const rows = database
    .prepare(
      `SELECT
        r.id,
        r.name,
        r.root_path,
        r.parent_source,
        r.default_branch,
        r.remote_url,
        r.github_owner,
        r.github_repo,
        r.is_active,
        r.created_at,
        r.updated_at,
        p.repo_id,
        p.autonomy_mode,
        p.allowed_root,
        p.allow_read,
        p.allow_edit,
        p.allow_bash,
        p.allow_git_write,
        p.allow_pr_create,
        p.safe_command_patterns_json,
        p.approval_required_for_edit,
        p.approval_required_for_commit,
        p.approval_required_for_pr,
        p.approval_required_for_risky_bash,
        p.cheap_provider,
        p.cheap_model,
        p.strong_provider,
        p.strong_model,
        p.classifier_provider,
        p.classifier_model,
        p.max_escalations,
        p.max_task_budget_usd
      FROM repositories r
      INNER JOIN repository_policies p ON p.repo_id = r.id
      ORDER BY r.name ASC`,
    )
    .all() as unknown as Array<RepositoryRow & RepositoryPolicyRow>;

  return rows.map(mapRepositoryDetailRow);
}

export function getRepositoryDetail(database: DatabaseSync, repoId: string) {
  const row = database
    .prepare(
      `SELECT
        r.id,
        r.name,
        r.root_path,
        r.parent_source,
        r.default_branch,
        r.remote_url,
        r.github_owner,
        r.github_repo,
        r.is_active,
        r.created_at,
        r.updated_at,
        p.repo_id,
        p.autonomy_mode,
        p.allowed_root,
        p.allow_read,
        p.allow_edit,
        p.allow_bash,
        p.allow_git_write,
        p.allow_pr_create,
        p.safe_command_patterns_json,
        p.approval_required_for_edit,
        p.approval_required_for_commit,
        p.approval_required_for_pr,
        p.approval_required_for_risky_bash,
        p.cheap_provider,
        p.cheap_model,
        p.strong_provider,
        p.strong_model,
        p.classifier_provider,
        p.classifier_model,
        p.max_escalations,
        p.max_task_budget_usd
      FROM repositories r
      INNER JOIN repository_policies p ON p.repo_id = r.id
      WHERE r.id = :repoId`,
    )
    .get({ repoId }) as unknown as (RepositoryRow & RepositoryPolicyRow) | undefined;

  return row ? mapRepositoryDetailRow(row) : null;
}

export function getRepositoryByRootPath(database: DatabaseSync, rootPath: string) {
  const row = database
    .prepare(
      `SELECT
        id,
        name,
        root_path,
        parent_source,
        default_branch,
        remote_url,
        github_owner,
        github_repo,
        is_active,
        created_at,
        updated_at
      FROM repositories
      WHERE root_path = :rootPath`,
    )
    .get({ rootPath }) as unknown as RepositoryRow | undefined;

  return row ? mapRepositoryRow(row) : null;
}

export function registerRepository(database: DatabaseSync, input: RepositoryRegistrationInput) {
  const existing = getRepositoryByRootPath(database, input.root_path);
  const repoId = existing?.id ?? randomUUID();

  database.exec("BEGIN");

  try {
    database
      .prepare(
        `INSERT INTO repositories (
          id,
          name,
          root_path,
          parent_source,
          default_branch,
          remote_url,
          github_owner,
          github_repo,
          is_active
        ) VALUES (
          :id,
          :name,
          :root_path,
          :parent_source,
          :default_branch,
          :remote_url,
          :github_owner,
          :github_repo,
          1
        )
        ON CONFLICT(root_path) DO UPDATE SET
          name = excluded.name,
          parent_source = excluded.parent_source,
          default_branch = excluded.default_branch,
          remote_url = excluded.remote_url,
          github_owner = excluded.github_owner,
          github_repo = excluded.github_repo,
          is_active = 1`,
      )
      .run({
        id: repoId,
        name: input.name,
        root_path: input.root_path,
        parent_source: input.parent_source,
        default_branch: input.default_branch,
        remote_url: input.remote_url,
        github_owner: input.github_owner,
        github_repo: input.github_repo,
      });

    saveRepositoryPolicy(database, repoId, input.policy);
    insertAuditEvent(
      database,
      repoId,
      null,
      existing ? "repository.updated" : "repository.registered",
      existing
        ? `Updated repository registration for ${input.name}.`
        : `Registered repository ${input.name}.`,
      {
        root_path: input.root_path,
        remote_url: input.remote_url,
      },
    );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const detail = getRepositoryDetail(database, repoId);

  if (!detail) {
    throw new Error(`Repository '${repoId}' was not available after registration.`);
  }

  return detail;
}

export function updateRepositoryPolicy(
  database: DatabaseSync,
  repoId: string,
  patch: Partial<RepositoryPolicyValues>,
) {
  const detail = getRepositoryDetail(database, repoId);

  if (!detail) {
    return null;
  }

  const nextPolicy: RepositoryPolicyValues = {
    ...toPolicyValues(detail.policy),
    ...autonomyModePolicyDefaults(patch.autonomy_mode),
    ...patch,
    allowed_root: patch.allowed_root ?? detail.policy.allowed_root,
  };

  database.exec("BEGIN");

  try {
    saveRepositoryPolicy(database, repoId, nextPolicy);
    insertAuditEvent(
      database,
      repoId,
      null,
      "repository_policy.updated",
      "Updated repository policy.",
      {
        changed_keys: Object.keys(patch).sort(),
      },
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return getRepositoryDetail(database, repoId);
}

export function listTasks(database: DatabaseSync, repoId?: string) {
  const query = `SELECT
      t.id,
      t.repo_id,
      t.title,
      t.user_prompt,
      t.goal_type,
      t.status,
      t.routing_tier,
      t.routing_reason,
      t.classifier_score,
      t.classifier_confidence,
      t.pi_session_id,
      t.branch_name,
      t.started_at,
      t.completed_at,
      t.created_at,
      r.id AS repository_id,
      r.name AS repository_name,
      r.default_branch AS repository_default_branch
    FROM tasks t
    INNER JOIN repositories r ON r.id = t.repo_id
    ${repoId ? "WHERE t.repo_id = :repoId" : ""}
    ORDER BY t.created_at DESC, t.id DESC`;
  const rows = database.prepare(query).all(repoId ? { repoId } : {}) as unknown as Array<
    TaskRow & TaskRepositoryRow
  >;

  return rows.map(mapTaskSummaryRow);
}

export function getTaskDetail(database: DatabaseSync, taskId: string) {
  const row = database
    .prepare(
      `SELECT
        t.id,
        t.repo_id,
        t.title,
        t.user_prompt,
        t.goal_type,
        t.status,
        t.routing_tier,
        t.routing_reason,
        t.classifier_score,
        t.classifier_confidence,
        t.pi_session_id,
        t.branch_name,
        t.started_at,
        t.completed_at,
        t.created_at,
        r.id AS repository_id,
        r.name AS repository_name,
        r.default_branch AS repository_default_branch
      FROM tasks t
      INNER JOIN repositories r ON r.id = t.repo_id
      WHERE t.id = :taskId`,
    )
    .get({ taskId }) as unknown as (TaskRow & TaskRepositoryRow) | undefined;

  return row
    ? {
        ...mapTaskSummaryRow(row),
        artifacts: listTaskArtifacts(database, taskId),
        approvals: listTaskApprovals(database, taskId),
        audit_events: listTaskAuditEvents(database, taskId),
      }
    : null;
}

export function listApprovals(database: DatabaseSync, status: ApprovalStatus = "pending") {
  const rows = database
    .prepare(
      `SELECT
        id,
        task_id,
        approval_type,
        requested_action,
        requested_payload_json,
        resolution_payload_json,
        status,
        decided_by,
        decided_at,
        created_at
      FROM approvals
      WHERE status = :status
      ORDER BY created_at ASC, id ASC`,
    )
    .all({ status }) as unknown as ApprovalRow[];

  return rows.map(mapApprovalRow);
}

export function getApproval(database: DatabaseSync, approvalId: string) {
  const row = database
    .prepare(
      `SELECT
        id,
        task_id,
        approval_type,
        requested_action,
        requested_payload_json,
        resolution_payload_json,
        status,
        decided_by,
        decided_at,
        created_at
      FROM approvals
      WHERE id = :approvalId`,
    )
    .get({ approvalId }) as unknown as ApprovalRow | undefined;

  return row ? mapApprovalRow(row) : null;
}

export function getTaskExecutionContext(database: DatabaseSync, taskId: string) {
  const task = getTaskRecord(database, taskId);

  if (!task) {
    return null;
  }

  const repositoryDetail = getRepositoryDetail(database, task.repo_id);

  if (!repositoryDetail) {
    return null;
  }

  return {
    task,
    repository: repositoryDetail.repository,
    policy: repositoryDetail.policy,
  } satisfies TaskExecutionContext;
}

export function createTask(database: DatabaseSync, values: TaskValues) {
  const taskId = randomUUID();

  database.exec("BEGIN");

  try {
    database
      .prepare(
        `INSERT INTO tasks (
          id,
          repo_id,
          title,
          user_prompt,
          goal_type,
          status,
          routing_tier,
          routing_reason,
          classifier_score,
          classifier_confidence,
          pi_session_id,
          branch_name,
          started_at,
          completed_at
        ) VALUES (
          :id,
          :repo_id,
          :title,
          :user_prompt,
          :goal_type,
          :status,
          :routing_tier,
          :routing_reason,
          :classifier_score,
          :classifier_confidence,
          :pi_session_id,
          :branch_name,
          :started_at,
          :completed_at
        )`,
      )
      .run({
        id: taskId,
        repo_id: values.repo_id,
        title: values.title,
        user_prompt: values.user_prompt,
        goal_type: values.goal_type,
        status: values.status,
        routing_tier: values.routing_tier,
        routing_reason: values.routing_reason,
        classifier_score: values.classifier_score,
        classifier_confidence: values.classifier_confidence,
        pi_session_id: values.pi_session_id,
        branch_name: values.branch_name,
        started_at: values.started_at,
        completed_at: values.completed_at,
      });

    insertAuditEvent(
      database,
      values.repo_id,
      taskId,
      "task.created",
      `Created task ${values.title}.`,
      {
        goal_type: values.goal_type,
        routing_tier: values.routing_tier,
        classifier_confidence: values.classifier_confidence,
      },
    );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const detail = getTaskDetail(database, taskId);

  if (!detail) {
    throw new Error(`Task '${taskId}' was not available after creation.`);
  }

  return detail;
}

export function updateTaskExecution(
  database: DatabaseSync,
  taskId: string,
  values: TaskExecutionValues,
) {
  const existing = getTaskRecord(database, taskId);

  if (!existing) {
    return null;
  }

  database
    .prepare(
      `UPDATE tasks
       SET status = :status,
           pi_session_id = :pi_session_id,
           branch_name = :branch_name,
           started_at = :started_at,
           completed_at = :completed_at
       WHERE id = :id`,
    )
    .run({
      id: taskId,
      status: values.status,
      pi_session_id: values.pi_session_id,
      branch_name: values.branch_name,
      started_at: values.started_at,
      completed_at: values.completed_at,
    });

  return getTaskRecord(database, taskId);
}

export function claimTaskExecution(
  database: DatabaseSync,
  taskId: string,
  allowedStatuses: readonly TaskRecord["status"][],
  values: TaskExecutionValues,
) {
  if (allowedStatuses.length === 0) {
    return null;
  }

  const statusBindings = Object.fromEntries(
    allowedStatuses.map((status, index) => [`status_${index}`, status]),
  );
  const placeholders = allowedStatuses.map((_, index) => `:status_${index}`).join(", ");
  const result = database
    .prepare(
      `UPDATE tasks
       SET status = :status,
           pi_session_id = :pi_session_id,
           branch_name = :branch_name,
           started_at = :started_at,
           completed_at = :completed_at
       WHERE id = :id
         AND status IN (${placeholders})`,
    )
    .run({
      id: taskId,
      status: values.status,
      pi_session_id: values.pi_session_id,
      branch_name: values.branch_name,
      started_at: values.started_at,
      completed_at: values.completed_at,
      ...statusBindings,
    });

  return result.changes === 0 ? null : getTaskRecord(database, taskId);
}

export function replaceTaskArtifacts(
  database: DatabaseSync,
  taskId: string,
  artifacts: readonly TaskArtifactValues[],
) {
  database.prepare("DELETE FROM task_artifacts WHERE task_id = :taskId").run({ taskId });

  if (artifacts.length === 0) {
    return;
  }

  const insert = database.prepare(
    `INSERT INTO task_artifacts (
      id,
      task_id,
      artifact_type,
      summary,
      payload_json
    ) VALUES (
      :id,
      :task_id,
      :artifact_type,
      :summary,
      :payload_json
    )`,
  );

  for (const artifact of artifacts) {
    insert.run({
      id: randomUUID(),
      task_id: taskId,
      artifact_type: artifact.artifact_type,
      summary: artifact.summary,
      payload_json: artifact.payload_json,
    });
  }
}

export function createApproval(database: DatabaseSync, values: ApprovalValues) {
  const approvalId = randomUUID();

  const result = database
    .prepare(
      `INSERT OR IGNORE INTO approvals (
        id,
        task_id,
        approval_type,
        requested_action,
        requested_payload_json,
        resolution_payload_json,
        status,
        decided_by,
        decided_at
      ) VALUES (
        :id,
        :task_id,
        :approval_type,
        :requested_action,
        :requested_payload_json,
        '{}',
        'pending',
        NULL,
        NULL
      )`,
    )
    .run({
      id: approvalId,
      task_id: values.task_id,
      approval_type: values.approval_type,
      requested_action: values.requested_action,
      requested_payload_json: values.requested_payload_json,
    });

  return result.changes === 0
    ? getPendingTaskApproval(database, values.task_id, values.approval_type)
    : getApproval(database, approvalId);
}

export function resolveApproval(
  database: DatabaseSync,
  approvalId: string,
  values: ApprovalResolutionValues,
) {
  const result = database
    .prepare(
      `UPDATE approvals
       SET status = :status,
           decided_by = :decided_by,
           decided_at = :decided_at,
           resolution_payload_json = :resolution_payload_json
       WHERE id = :id
         AND status = 'pending'`,
    )
    .run({
      id: approvalId,
      status: values.status,
      decided_by: values.decided_by,
      decided_at: values.decided_at,
      resolution_payload_json: values.resolution_payload_json ?? "{}",
    });

  if (result.changes === 0) {
    return null;
  }

  return getApproval(database, approvalId);
}

export function createRiskyBashGrant(database: DatabaseSync, values: RiskyBashGrantValues) {
  const grantId = randomUUID();

  database
    .prepare(
      `INSERT INTO risky_bash_grants (
        id,
        approval_id,
        repo_id,
        task_id,
        session_key,
        scope,
        command,
        command_fingerprint,
        decided_by,
        consumed_at
      ) VALUES (
        :id,
        :approval_id,
        :repo_id,
        :task_id,
        :session_key,
        :scope,
        :command,
        :command_fingerprint,
        :decided_by,
        NULL
      )`,
    )
    .run({
      id: grantId,
      approval_id: values.approval_id,
      repo_id: values.repo_id,
      task_id: values.task_id,
      session_key: values.session_key,
      scope: values.scope,
      command: values.command,
      command_fingerprint: values.command_fingerprint,
      decided_by: values.decided_by,
    });

  return getRiskyBashGrant(database, grantId);
}

export function getRiskyBashGrant(database: DatabaseSync, grantId: string) {
  const row = database
    .prepare(
      `SELECT
        id,
        approval_id,
        repo_id,
        task_id,
        session_key,
        scope,
        command,
        command_fingerprint,
        decided_by,
        consumed_at,
        created_at
      FROM risky_bash_grants
      WHERE id = :grantId`,
    )
    .get({ grantId }) as unknown as RiskyBashGrantRow | undefined;

  return row ? mapRiskyBashGrantRow(row) : null;
}

export function findReusableRiskyBashGrant(database: DatabaseSync, lookup: RiskyBashGrantLookup) {
  const onceGrant = database
    .prepare(
      `SELECT
        id,
        approval_id,
        repo_id,
        task_id,
        session_key,
        scope,
        command,
        command_fingerprint,
        decided_by,
        consumed_at,
        created_at
      FROM risky_bash_grants
      WHERE scope = 'once'
        AND task_id = :task_id
        AND session_key = :session_key
        AND command_fingerprint = :command_fingerprint
        AND consumed_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    )
    .get({
      task_id: lookup.task_id,
      session_key: lookup.session_key,
      command_fingerprint: lookup.command_fingerprint,
    }) as unknown as RiskyBashGrantRow | undefined;

  if (onceGrant) {
    return mapRiskyBashGrantRow(onceGrant);
  }

  const sessionGrant = database
    .prepare(
      `SELECT
        id,
        approval_id,
        repo_id,
        task_id,
        session_key,
        scope,
        command,
        command_fingerprint,
        decided_by,
        consumed_at,
        created_at
      FROM risky_bash_grants
      WHERE scope = 'session'
        AND session_key = :session_key
        AND command_fingerprint = :command_fingerprint
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    )
    .get({
      session_key: lookup.session_key,
      command_fingerprint: lookup.command_fingerprint,
    }) as unknown as RiskyBashGrantRow | undefined;

  if (sessionGrant) {
    return mapRiskyBashGrantRow(sessionGrant);
  }

  const globalGrant = database
    .prepare(
      `SELECT
        id,
        approval_id,
        repo_id,
        task_id,
        session_key,
        scope,
        command,
        command_fingerprint,
        decided_by,
        consumed_at,
        created_at
      FROM risky_bash_grants
      WHERE scope = 'global'
        AND repo_id = :repo_id
        AND command_fingerprint = :command_fingerprint
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    )
    .get({
      repo_id: lookup.repo_id,
      command_fingerprint: lookup.command_fingerprint,
    }) as unknown as RiskyBashGrantRow | undefined;

  return globalGrant ? mapRiskyBashGrantRow(globalGrant) : null;
}

export function consumeRiskyBashGrant(database: DatabaseSync, grantId: string, consumedAt: string) {
  const result = database
    .prepare(
      `UPDATE risky_bash_grants
       SET consumed_at = :consumed_at
       WHERE id = :id
         AND scope = 'once'
         AND consumed_at IS NULL`,
    )
    .run({
      id: grantId,
      consumed_at: consumedAt,
    });

  return result.changes > 0;
}

export function getPendingTaskApproval(
  database: DatabaseSync,
  taskId: string,
  approvalType?: ApprovalType,
) {
  const row = database
    .prepare(
      `SELECT
        id,
        task_id,
        approval_type,
        requested_action,
        requested_payload_json,
        resolution_payload_json,
        status,
        decided_by,
        decided_at,
        created_at
      FROM approvals
      WHERE task_id = :taskId
        AND status = 'pending'
        ${approvalType ? "AND approval_type = :approvalType" : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    )
    .get(approvalType ? { taskId, approvalType } : { taskId }) as unknown as
    | ApprovalRow
    | undefined;

  return row ? mapApprovalRow(row) : null;
}

export function getLatestApprovedTaskApproval(
  database: DatabaseSync,
  taskId: string,
  approvalType?: ApprovalType,
) {
  const row = database
    .prepare(
      `SELECT
        id,
        task_id,
        approval_type,
        requested_action,
        requested_payload_json,
        resolution_payload_json,
        status,
        decided_by,
        decided_at,
        created_at
      FROM approvals
      WHERE task_id = :taskId
        AND status = 'approved'
        ${approvalType ? "AND approval_type = :approvalType" : ""}
      ORDER BY decided_at DESC, created_at DESC, id DESC
      LIMIT 1`,
    )
    .get(approvalType ? { taskId, approvalType } : { taskId }) as unknown as
    | ApprovalRow
    | undefined;

  return row ? mapApprovalRow(row) : null;
}

export function recordAuditEvent(
  database: DatabaseSync,
  repoId: string | null,
  taskId: string | null,
  eventType: string,
  message: string,
  details: Record<string, unknown>,
) {
  insertAuditEvent(database, repoId, taskId, eventType, message, details);
}

function saveRepositoryPolicy(
  database: DatabaseSync,
  repoId: string,
  policy: RepositoryPolicyValues,
) {
  database
    .prepare(
      `INSERT INTO repository_policies (
        repo_id,
        autonomy_mode,
        allowed_root,
        allow_read,
        allow_edit,
        allow_bash,
        allow_git_write,
        allow_pr_create,
        safe_command_patterns_json,
        approval_required_for_edit,
        approval_required_for_commit,
        approval_required_for_pr,
        approval_required_for_risky_bash,
        cheap_provider,
        cheap_model,
        strong_provider,
        strong_model,
        classifier_provider,
        classifier_model,
        max_escalations,
        max_task_budget_usd
      ) VALUES (
        :repo_id,
        :autonomy_mode,
        :allowed_root,
        :allow_read,
        :allow_edit,
        :allow_bash,
        :allow_git_write,
        :allow_pr_create,
        :safe_command_patterns_json,
        :approval_required_for_edit,
        :approval_required_for_commit,
        :approval_required_for_pr,
        :approval_required_for_risky_bash,
        :cheap_provider,
        :cheap_model,
        :strong_provider,
        :strong_model,
        :classifier_provider,
        :classifier_model,
        :max_escalations,
        :max_task_budget_usd
      )
      ON CONFLICT(repo_id) DO UPDATE SET
        autonomy_mode = excluded.autonomy_mode,
        allowed_root = excluded.allowed_root,
        allow_read = excluded.allow_read,
        allow_edit = excluded.allow_edit,
        allow_bash = excluded.allow_bash,
        allow_git_write = excluded.allow_git_write,
        allow_pr_create = excluded.allow_pr_create,
        safe_command_patterns_json = excluded.safe_command_patterns_json,
        approval_required_for_edit = excluded.approval_required_for_edit,
        approval_required_for_commit = excluded.approval_required_for_commit,
        approval_required_for_pr = excluded.approval_required_for_pr,
        approval_required_for_risky_bash = excluded.approval_required_for_risky_bash,
        cheap_provider = excluded.cheap_provider,
        cheap_model = excluded.cheap_model,
        strong_provider = excluded.strong_provider,
        strong_model = excluded.strong_model,
        classifier_provider = excluded.classifier_provider,
        classifier_model = excluded.classifier_model,
        max_escalations = excluded.max_escalations,
        max_task_budget_usd = excluded.max_task_budget_usd`,
    )
    .run({
      repo_id: repoId,
      autonomy_mode: policy.autonomy_mode,
      allowed_root: policy.allowed_root,
      allow_read: Number(policy.allow_read),
      allow_edit: Number(policy.allow_edit),
      allow_bash: Number(policy.allow_bash),
      allow_git_write: Number(policy.allow_git_write),
      allow_pr_create: Number(policy.allow_pr_create),
      safe_command_patterns_json: JSON.stringify(policy.safe_command_patterns),
      approval_required_for_edit: Number(policy.approval_required_for_edit),
      approval_required_for_commit: Number(policy.approval_required_for_commit),
      approval_required_for_pr: Number(policy.approval_required_for_pr),
      approval_required_for_risky_bash: Number(policy.approval_required_for_risky_bash),
      cheap_provider: policy.cheap_provider,
      cheap_model: policy.cheap_model,
      strong_provider: policy.strong_provider,
      strong_model: policy.strong_model,
      classifier_provider: policy.classifier_provider,
      classifier_model: policy.classifier_model,
      max_escalations: policy.max_escalations,
      max_task_budget_usd: policy.max_task_budget_usd,
    });
}

function getTaskRecord(database: DatabaseSync, taskId: string) {
  const row = database
    .prepare(
      `SELECT
        id,
        repo_id,
        title,
        user_prompt,
        goal_type,
        status,
        routing_tier,
        routing_reason,
        classifier_score,
        classifier_confidence,
        pi_session_id,
        branch_name,
        started_at,
        completed_at,
        created_at
      FROM tasks
      WHERE id = :taskId`,
    )
    .get({ taskId }) as unknown as TaskRow | undefined;

  return row ? mapTaskRow(row) : null;
}

function insertAuditEvent(
  database: DatabaseSync,
  repoId: string | null,
  taskId: string | null,
  eventType: string,
  message: string,
  details: Record<string, unknown>,
) {
  database
    .prepare(
      `INSERT INTO audit_events (
        id,
        repo_id,
        task_id,
        event_type,
        message,
        details_json
      ) VALUES (
        :id,
        :repo_id,
        :task_id,
        :event_type,
        :message,
        :details_json
      )`,
    )
    .run({
      id: randomUUID(),
      repo_id: repoId,
      task_id: taskId,
      event_type: eventType,
      message,
      details_json: JSON.stringify(details),
    });
}

function listTaskArtifacts(database: DatabaseSync, taskId: string) {
  const rows = database
    .prepare(
      `SELECT
        id,
        task_id,
        artifact_type,
        summary,
        payload_json,
        created_at
      FROM task_artifacts
      WHERE task_id = :taskId
      ORDER BY created_at ASC, id ASC`,
    )
    .all({ taskId }) as unknown as TaskArtifactRow[];

  return rows.map(mapTaskArtifactRow);
}

function listTaskAuditEvents(database: DatabaseSync, taskId: string) {
  const rows = database
    .prepare(
      `SELECT
        id,
        repo_id,
        task_id,
        event_type,
        message,
        details_json,
        created_at
      FROM audit_events
      WHERE task_id = :taskId
      ORDER BY created_at ASC, id ASC`,
    )
    .all({ taskId }) as unknown as AuditEventRow[];

  return rows.map(mapAuditEventRow);
}

function listTaskApprovals(database: DatabaseSync, taskId: string) {
  const rows = database
    .prepare(
      `SELECT
        id,
        task_id,
        approval_type,
        requested_action,
        requested_payload_json,
        resolution_payload_json,
        status,
        decided_by,
        decided_at,
        created_at
      FROM approvals
      WHERE task_id = :taskId
      ORDER BY created_at ASC, id ASC`,
    )
    .all({ taskId }) as unknown as ApprovalRow[];

  return rows.map(mapApprovalRow);
}

function mapRepositoryDetailRow(row: RepositoryRow & RepositoryPolicyRow): RepositoryDetail {
  return {
    repository: mapRepositoryRow(row),
    policy: mapRepositoryPolicyRow(row),
  };
}

function mapTaskSummaryRow(row: TaskRow & TaskRepositoryRow): TaskSummary {
  return {
    task: mapTaskRow(row),
    repository: {
      id: row.repository_id,
      name: row.repository_name,
      default_branch: row.repository_default_branch,
    },
  };
}

function mapRepositoryRow(row: RepositoryRow): RepositoryRecord {
  return {
    id: row.id,
    name: row.name,
    root_path: row.root_path,
    parent_source: row.parent_source,
    default_branch: row.default_branch,
    remote_url: row.remote_url,
    github_owner: row.github_owner,
    github_repo: row.github_repo,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapRepositoryPolicyRow(row: RepositoryPolicyRow): RepositoryPolicyRecord {
  return {
    repo_id: row.repo_id,
    autonomy_mode: row.autonomy_mode,
    allowed_root: row.allowed_root,
    allow_read: Boolean(row.allow_read),
    allow_edit: Boolean(row.allow_edit),
    allow_bash: Boolean(row.allow_bash),
    allow_git_write: Boolean(row.allow_git_write),
    allow_pr_create: Boolean(row.allow_pr_create),
    safe_command_patterns: JSON.parse(row.safe_command_patterns_json) as string[],
    approval_required_for_edit: Boolean(row.approval_required_for_edit),
    approval_required_for_commit: Boolean(row.approval_required_for_commit),
    approval_required_for_pr: Boolean(row.approval_required_for_pr),
    approval_required_for_risky_bash: Boolean(row.approval_required_for_risky_bash),
    cheap_provider: row.cheap_provider,
    cheap_model: row.cheap_model,
    strong_provider: row.strong_provider,
    strong_model: row.strong_model,
    classifier_provider: row.classifier_provider,
    classifier_model: row.classifier_model,
    max_escalations: row.max_escalations,
    max_task_budget_usd: row.max_task_budget_usd,
  };
}

function mapTaskRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    repo_id: row.repo_id,
    title: row.title,
    user_prompt: row.user_prompt,
    goal_type: row.goal_type,
    status: row.status,
    routing_tier: row.routing_tier,
    routing_reason: row.routing_reason,
    classifier_score: row.classifier_score,
    classifier_confidence: row.classifier_confidence,
    pi_session_id: row.pi_session_id,
    branch_name: row.branch_name,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
  };
}

function mapTaskArtifactRow(row: TaskArtifactRow): TaskArtifactRecord {
  return {
    id: row.id,
    task_id: row.task_id,
    artifact_type: row.artifact_type,
    summary: row.summary,
    payload_json: row.payload_json,
    created_at: row.created_at,
  };
}

function mapApprovalRow(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    task_id: row.task_id,
    approval_type: row.approval_type,
    requested_action: row.requested_action,
    requested_payload_json: row.requested_payload_json,
    resolution_payload_json: row.resolution_payload_json,
    status: row.status,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    created_at: row.created_at,
  };
}

function mapRiskyBashGrantRow(row: RiskyBashGrantRow): RiskyBashGrantRecord {
  return {
    id: row.id,
    approval_id: row.approval_id,
    repo_id: row.repo_id,
    task_id: row.task_id,
    session_key: row.session_key,
    scope: row.scope,
    command: row.command,
    command_fingerprint: row.command_fingerprint,
    decided_by: row.decided_by,
    consumed_at: row.consumed_at,
    created_at: row.created_at,
  };
}

function mapAuditEventRow(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    repo_id: row.repo_id,
    task_id: row.task_id,
    event_type: row.event_type,
    message: row.message,
    details_json: row.details_json,
    created_at: row.created_at,
  };
}

function toPolicyValues(policy: RepositoryPolicyRecord): RepositoryPolicyValues {
  const values = { ...policy } as Partial<RepositoryPolicyRecord>;

  delete values.repo_id;

  return values as RepositoryPolicyValues;
}

function autonomyModePolicyDefaults(
  autonomyMode: RepositoryPolicyRecord["autonomy_mode"] | undefined,
): Partial<RepositoryPolicyValues> {
  if (!autonomyMode) {
    return {};
  }

  const defaults = {
    allow_read: true,
    allow_edit: false,
    allow_bash: false,
    allow_git_write: false,
    allow_pr_create: false,
    approval_required_for_edit: true,
    approval_required_for_commit: true,
    approval_required_for_pr: true,
    approval_required_for_risky_bash: true,
  } satisfies Pick<
    RepositoryPolicyValues,
    | "allow_read"
    | "allow_edit"
    | "allow_bash"
    | "allow_git_write"
    | "allow_pr_create"
    | "approval_required_for_edit"
    | "approval_required_for_commit"
    | "approval_required_for_pr"
    | "approval_required_for_risky_bash"
  >;

  switch (autonomyMode) {
    case "read-only":
      return defaults;
    case "approve-writes":
      return {
        ...defaults,
        allow_edit: true,
        allow_bash: true,
      };
    case "approve-commits":
      return {
        ...defaults,
        allow_edit: true,
        allow_bash: true,
        allow_git_write: true,
      };
    case "trusted":
      return {
        ...defaults,
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
