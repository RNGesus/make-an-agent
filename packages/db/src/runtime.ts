import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { RepositoryPolicyRecord, RepositoryRecord } from "shared";
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
}

export function bootstrapControlPlaneDatabase(options: DatabaseBootstrapOptions) {
  const filePath = resolveDatabasePath(options.databasePath, options.cwd);

  mkdirSync(dirname(filePath), { recursive: true });

  const database = new DatabaseSync(filePath);
  applyConnectionPragmas(database);
  applyInitialSchema(database);

  return database;
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
    insertAuditEvent(database, repoId, "repository_policy.updated", "Updated repository policy.", {
      changed_keys: Object.keys(patch).sort(),
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return getRepositoryDetail(database, repoId);
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

function insertAuditEvent(
  database: DatabaseSync,
  repoId: string,
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
        NULL,
        :event_type,
        :message,
        :details_json
      )`,
    )
    .run({
      id: randomUUID(),
      repo_id: repoId,
      event_type: eventType,
      message,
      details_json: JSON.stringify(details),
    });
}

function mapRepositoryDetailRow(row: RepositoryRow & RepositoryPolicyRow): RepositoryDetail {
  return {
    repository: mapRepositoryRow(row),
    policy: mapRepositoryPolicyRow(row),
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
