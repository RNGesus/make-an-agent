PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL UNIQUE,
  parent_source TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  remote_url TEXT,
  github_owner TEXT,
  github_repo TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS repository_policies (
  repo_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  autonomy_mode TEXT NOT NULL,
  allowed_root TEXT NOT NULL,
  allow_read INTEGER NOT NULL DEFAULT 1 CHECK (allow_read IN (0, 1)),
  allow_edit INTEGER NOT NULL DEFAULT 0 CHECK (allow_edit IN (0, 1)),
  allow_bash INTEGER NOT NULL DEFAULT 0 CHECK (allow_bash IN (0, 1)),
  allow_git_write INTEGER NOT NULL DEFAULT 0 CHECK (allow_git_write IN (0, 1)),
  allow_pr_create INTEGER NOT NULL DEFAULT 0 CHECK (allow_pr_create IN (0, 1)),
  safe_command_patterns_json TEXT NOT NULL DEFAULT '[]',
  approval_required_for_edit INTEGER NOT NULL DEFAULT 1 CHECK (approval_required_for_edit IN (0, 1)),
  approval_required_for_commit INTEGER NOT NULL DEFAULT 1 CHECK (approval_required_for_commit IN (0, 1)),
  approval_required_for_pr INTEGER NOT NULL DEFAULT 1 CHECK (approval_required_for_pr IN (0, 1)),
  approval_required_for_risky_bash INTEGER NOT NULL DEFAULT 1 CHECK (approval_required_for_risky_bash IN (0, 1)),
  cheap_provider TEXT NOT NULL,
  cheap_model TEXT NOT NULL,
  strong_provider TEXT NOT NULL,
  strong_model TEXT NOT NULL,
  classifier_provider TEXT,
  classifier_model TEXT,
  max_escalations INTEGER NOT NULL DEFAULT 1,
  max_task_budget_usd REAL NOT NULL DEFAULT 10.0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  goal_type TEXT NOT NULL,
  status TEXT NOT NULL,
  routing_tier TEXT,
  routing_reason TEXT,
  classifier_score REAL,
  classifier_confidence REAL,
  pi_session_id TEXT,
  branch_name TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  approval_type TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  requested_payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  repo_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS repositories_set_updated_at
AFTER UPDATE ON repositories
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE repositories
  SET updated_at = CURRENT_TIMESTAMP
  WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS repository_policies_set_updated_at
AFTER UPDATE ON repository_policies
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE repository_policies
  SET updated_at = CURRENT_TIMESTAMP
  WHERE repo_id = OLD.repo_id;
END;

CREATE INDEX IF NOT EXISTS repositories_active_idx ON repositories(is_active);
CREATE INDEX IF NOT EXISTS tasks_repo_created_idx ON tasks(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_status_created_idx ON tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS task_artifacts_task_idx ON task_artifacts(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS approvals_status_created_idx ON approvals(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_pending_task_type_idx
ON approvals(task_id, approval_type)
WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS audit_events_repo_created_idx ON audit_events(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_task_created_idx ON audit_events(task_id, created_at DESC);
