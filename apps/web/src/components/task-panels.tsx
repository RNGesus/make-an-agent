import { Link } from "@tanstack/react-router";
import { taskGoalTypes, type ApprovalRecord, type AuditEventRecord } from "shared";
import type { RepositoryDetail, TaskDetail, TaskDiff, TaskSummary } from "../lib/operator-api";
import {
  readApprovalRequestMeta,
  readApprovalScope,
  readArtifactText,
  readArtifactValue,
  readChangedFiles,
} from "../lib/operator-api";

type TaskFormPanelProps = {
  onSubmit: (formData: FormData) => Promise<void>;
  repositoryDetail: RepositoryDetail | null;
};

type TaskListPanelProps = {
  repoId: string | null;
  selectedTaskId: string | null;
  tasks: TaskSummary[];
};

type TaskDetailPanelProps = {
  onCommit: (taskId: string, message?: string) => Promise<void>;
  onCreatePullRequest: (taskId: string) => Promise<void>;
  onRetry: (taskId: string) => Promise<void>;
  taskDiff: TaskDiff | null;
  taskDetail: TaskDetail | null;
};

export function TaskFormPanel(props: TaskFormPanelProps) {
  return (
    <article className="panel">
      <div className="section-head compact-head">
        <div>
          <p className="eyebrow">Task Intake</p>
          <h2>Create a routed task</h2>
        </div>
      </div>

      {!props.repositoryDetail ? (
        <p className="empty-state">Choose a repository before submitting a task.</p>
      ) : (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            void props.onSubmit(new FormData(form)).then(() => {
              form.reset();
            });
          }}
        >
          <div className="field-grid two-up">
            <label>
              <span>Goal type</span>
              <select defaultValue="" name="goal_type">
                <option value="">Infer from prompt</option>
                {taskGoalTypes.map((goalType) => (
                  <option key={goalType} value={goalType}>
                    {goalType}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Expected files</span>
              <input
                min="0"
                name="expected_file_count"
                placeholder="optional"
                step="1"
                type="number"
              />
            </label>
          </div>

          <label>
            <span>Task title</span>
            <input name="title" placeholder="optional short label" />
          </label>

          <label>
            <span>Prompt</span>
            <textarea
              name="user_prompt"
              placeholder="Describe the repo question, plan, fix, or implementation request."
              rows={6}
            ></textarea>
          </label>

          <div className="form-actions">
            <button className="solid-button" type="submit">
              Create routed task
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

export function TaskListPanel(props: TaskListPanelProps) {
  return (
    <article className="panel">
      <div className="section-head compact-head">
        <div>
          <p className="eyebrow">Task History</p>
          <h2>{props.repoId ? "Tasks for the selected repository" : "Waiting for a repo"}</h2>
        </div>
      </div>

      <div className="task-list">
        {props.tasks.length === 0 ? (
          <p className="empty-state">No tasks have been submitted for this repository yet.</p>
        ) : (
          props.tasks.map((entry) => {
            const isSelected = entry.task.id === props.selectedTaskId;

            return props.repoId ? (
              <Link
                className={`task-item ${isSelected ? "task-item-selected" : ""}`}
                key={entry.task.id}
                params={{ repoId: props.repoId, taskId: entry.task.id }}
                to="/repos/$repoId/tasks/$taskId"
              >
                <span>
                  <strong>{entry.task.title}</strong>
                  <small>{entry.task.goal_type + " · " + entry.task.status}</small>
                </span>
                <span className={`tier tier-${entry.task.routing_tier ?? "pending"}`}>
                  {entry.task.routing_tier ?? "pending"}
                </span>
              </Link>
            ) : null;
          })
        )}
      </div>
    </article>
  );
}

export function TaskDetailPanel(props: TaskDetailPanelProps) {
  const taskDetail = props.taskDetail;

  return (
    <article className="panel detail-panel">
      <div className="section-head compact-head">
        <div>
          <p className="eyebrow">Execution Detail</p>
          <h2>{taskDetail ? taskDetail.task.title : "Select a task"}</h2>
        </div>
        {taskDetail && taskDetail.task.status !== "running" ? (
          <button
            className="ghost-button"
            onClick={() => void props.onRetry(taskDetail.task.id)}
            type="button"
          >
            Run task
          </button>
        ) : null}
      </div>

      {!taskDetail ? (
        <p className="empty-state">
          Select a task to inspect the stored session, artifacts, and routing record.
        </p>
      ) : (
        <TaskDetailContent
          onCommit={props.onCommit}
          onCreatePullRequest={props.onCreatePullRequest}
          taskDetail={taskDetail}
          taskDiff={props.taskDiff}
        />
      )}
    </article>
  );
}

function TaskDetailContent(props: {
  onCommit: (taskId: string, message?: string) => Promise<void>;
  onCreatePullRequest: (taskId: string) => Promise<void>;
  taskDetail: TaskDetail;
  taskDiff: TaskDiff | null;
}) {
  const { artifacts, approvals, audit_events: auditEvents, repository, task } = props.taskDetail;
  const classifierConfidence =
    task.classifier_confidence === null
      ? "Not used"
      : `${Math.round(task.classifier_confidence * 100)}%`;
  const classifierScore =
    task.classifier_score === null ? "Not used" : task.classifier_score.toFixed(2);
  const finalAnswer = readArtifactText(artifacts, "final_answer");
  const changedFiles = readChangedFiles(artifacts);
  const diffSummary = readArtifactValue<{ stat?: string }>(artifacts, "diff_summary")?.stat ?? null;
  const executionNotes =
    readArtifactValue<{ notes?: string[] }>(artifacts, "execution_notes")?.notes ?? [];
  const commitMetadata = readArtifactValue<{
    branch_name?: string;
    committed_at?: string;
    message?: string;
    sha?: string;
  }>(artifacts, "commit_metadata");
  const pullRequestMetadata = readArtifactValue<{
    base_branch?: string;
    body?: string;
    compare_url?: string | null;
    head_branch?: string;
    head_sha?: string;
    status?: string;
    title?: string;
  }>(artifacts, "pr_metadata");

  return (
    <div className="detail-stack">
      <div className="detail-row">
        <span className="chip">{repository.name}</span>
        <span className={`tier tier-${task.routing_tier ?? "pending"}`}>
          {task.routing_tier ?? "pending"}
        </span>
      </div>
      <p className="detail-prompt">{task.user_prompt}</p>
      <dl className="detail-grid">
        <div>
          <dt>Goal type</dt>
          <dd>{task.goal_type}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{task.status}</dd>
        </div>
        <div>
          <dt>Classifier score</dt>
          <dd>{classifierScore}</dd>
        </div>
        <div>
          <dt>Classifier confidence</dt>
          <dd>{classifierConfidence}</dd>
        </div>
        <div>
          <dt>Pi session</dt>
          <dd>{task.pi_session_id ?? "Pending"}</dd>
        </div>
        <div>
          <dt>Completed at</dt>
          <dd>{task.completed_at ?? "Pending"}</dd>
        </div>
      </dl>
      <div className="routing-callout">
        <p className="eyebrow">Routing reason</p>
        <p>{task.routing_reason ?? "Routing has not been computed yet."}</p>
      </div>

      <TaskSection title="Final answer">
        <div className="detail-card">
          <p>{finalAnswer ?? "Execution has not produced a final answer yet."}</p>
        </div>
      </TaskSection>

      <TaskSection title="Workspace artifacts">
        <div className="detail-card detail-card-stack">
          <p>{diffSummary ?? "No diff summary is stored for this task yet."}</p>
          <ChangedFilesCard files={changedFiles} />
          <NotesCard notes={executionNotes} />
        </div>
      </TaskSection>

      <TaskSection title="Branch and diff">
        <div className="detail-card detail-card-stack">
          <BranchStatusCard
            commitMetadata={commitMetadata}
            onCommit={props.onCommit}
            onCreatePullRequest={props.onCreatePullRequest}
            pullRequestMetadata={pullRequestMetadata}
            task={task}
            taskDiff={props.taskDiff}
          />
        </div>
      </TaskSection>

      <TaskSection title="Approval history">
        <div className="detail-card detail-card-stack">
          <TaskApprovals approvals={approvals} />
        </div>
      </TaskSection>

      <TaskSection title="Audit trail">
        <div className="detail-card detail-card-stack">
          <AuditEvents auditEvents={auditEvents} />
        </div>
      </TaskSection>
    </div>
  );
}

function BranchStatusCard(props: {
  commitMetadata: {
    branch_name?: string;
    committed_at?: string;
    message?: string;
    sha?: string;
  } | null;
  onCommit: (taskId: string, message?: string) => Promise<void>;
  onCreatePullRequest: (taskId: string) => Promise<void>;
  pullRequestMetadata: {
    base_branch?: string;
    body?: string;
    compare_url?: string | null;
    head_branch?: string;
    head_sha?: string;
    status?: string;
    title?: string;
  } | null;
  task: TaskDetail["task"];
  taskDiff: TaskDiff | null;
}) {
  if (!props.task.branch_name) {
    return <p className="empty-state">This task does not use a dedicated task branch.</p>;
  }

  return (
    <>
      <div className="detail-grid">
        <div>
          <dt>Task branch</dt>
          <dd>{props.task.branch_name}</dd>
        </div>
        <div>
          <dt>Current branch</dt>
          <dd>{props.taskDiff?.current_branch ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Base branch</dt>
          <dd>{props.taskDiff?.base_branch ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Head commit</dt>
          <dd>{props.taskDiff?.head_sha ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Ahead / behind</dt>
          <dd>
            {(props.taskDiff?.ahead_by ?? 0) +
              " ahead / " +
              (props.taskDiff?.behind_by ?? 0) +
              " behind"}
          </dd>
        </div>
        <div>
          <dt>Working tree</dt>
          <dd>{props.taskDiff?.has_changes ? "Uncommitted changes" : "Clean"}</dd>
        </div>
      </div>

      {props.commitMetadata ? (
        <div className="routing-callout">
          <p className="eyebrow">Latest commit</p>
          <p>
            {(props.commitMetadata.sha ?? "unknown") +
              " · " +
              (props.commitMetadata.message ?? "No commit message stored")}
          </p>
        </div>
      ) : null}

      {props.pullRequestMetadata ? (
        <div className="routing-callout">
          <p className="eyebrow">Pull request draft</p>
          <p>{props.pullRequestMetadata.title ?? "PR draft prepared"}</p>
          {props.pullRequestMetadata.compare_url ? (
            <a
              className="ghost-button action-link"
              href={props.pullRequestMetadata.compare_url}
              rel="noreferrer"
              target="_blank"
            >
              Open compare view
            </a>
          ) : null}
        </div>
      ) : null}

      <form
        className="task-action-row"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const message = formData.get("commit_message");

          void props.onCommit(props.task.id, typeof message === "string" ? message : undefined);
        }}
      >
        <input
          defaultValue={props.commitMetadata?.message ?? `Task: ${props.task.title}`}
          name="commit_message"
          placeholder="Commit message"
        />
        <button className="solid-button" type="submit">
          Commit changes
        </button>
        <button
          className="ghost-button"
          onClick={() => void props.onCreatePullRequest(props.task.id)}
          type="button"
        >
          Create PR draft
        </button>
      </form>

      <ChangedFilesCard files={props.taskDiff?.changed_files ?? []} />
      <DiffPatchCard
        diffStat={props.taskDiff?.diff_stat ?? ""}
        patch={props.taskDiff?.patch ?? ""}
      />
    </>
  );
}

function TaskSection(props: { children: React.ReactNode; title: string }) {
  return (
    <div className="detail-section">
      <p className="eyebrow">{props.title}</p>
      {props.children}
    </div>
  );
}

function ChangedFilesCard(props: { files: Array<{ path: string; status: string }> }) {
  if (props.files.length === 0) {
    return (
      <p className="empty-state">No changed files were captured for the allowed workspace root.</p>
    );
  }

  return (
    <div className="artifact-list">
      {props.files.map((file) => (
        <div className="artifact-row" key={file.path + file.status}>
          <code>{file.path}</code>
          <span className="chip chip-soft">{file.status}</span>
        </div>
      ))}
    </div>
  );
}

function DiffPatchCard(props: { diffStat: string; patch: string }) {
  if (!props.diffStat && !props.patch) {
    return <p className="empty-state">No live diff is available for this task branch right now.</p>;
  }

  return (
    <div className="artifact-list">
      {props.diffStat ? <p>{props.diffStat}</p> : null}
      {props.patch ? (
        <pre className="command-preview diff-preview">
          <code>{props.patch}</code>
        </pre>
      ) : null}
    </div>
  );
}

function NotesCard(props: { notes: string[] }) {
  if (props.notes.length === 0) {
    return null;
  }

  return (
    <div className="artifact-list">
      {props.notes.map((note) => (
        <p className="artifact-note" key={note}>
          {note}
        </p>
      ))}
    </div>
  );
}

function AuditEvents(props: { auditEvents: AuditEventRecord[] }) {
  if (props.auditEvents.length === 0) {
    return <p className="empty-state">No audit events were recorded for this task yet.</p>;
  }

  return (
    <div className="artifact-list">
      {props.auditEvents.map((event) => (
        <div className="artifact-row artifact-row-stack" key={event.id}>
          <strong>{event.message}</strong>
          <small>{event.event_type + " · " + event.created_at}</small>
        </div>
      ))}
    </div>
  );
}

function TaskApprovals(props: { approvals: ApprovalRecord[] }) {
  if (props.approvals.length === 0) {
    return <p className="empty-state">No approvals were recorded for this task.</p>;
  }

  return (
    <div className="artifact-list">
      {props.approvals.map((approval) => {
        const meta = readApprovalRequestMeta(approval);
        const scope = readApprovalScope(approval);
        const title =
          approval.approval_type === "risky_bash" && meta.command
            ? meta.command
            : approval.requested_action;

        return (
          <div className="artifact-row artifact-row-stack" key={approval.id}>
            <strong>{title}</strong>
            <small>
              {approval.approval_type + " · " + approval.status + (scope ? ` · ${scope}` : "")}
            </small>
          </div>
        );
      })}
    </div>
  );
}
