import { Link } from "@tanstack/react-router";
import { approvalScopes, type ApprovalRecord, type ApprovalScope } from "shared";
import { readApprovalRequestMeta, renderApprovalScopeLabel } from "../lib/operator-api";

type ApprovalPanelProps = {
  approvals: ApprovalRecord[];
  onApprove: (approvalId: string, scope: ApprovalScope | null) => Promise<void>;
  onReject: (approvalId: string) => Promise<void>;
  selectedApproval: ApprovalRecord | null;
  selectedApprovalId: string | null;
};

export function ApprovalPanel(props: ApprovalPanelProps) {
  return (
    <article className="panel">
      <div className="section-head">
        <div>
          <p className="eyebrow">Approval Queue</p>
          <h2>Pending approvals and resume controls</h2>
        </div>
        <span className="badge">{props.approvals.length} pending</span>
      </div>

      <div className="approval-grid">
        <div className="approval-list">
          {props.approvals.length === 0 ? (
            <p className="empty-state">No approvals are waiting right now.</p>
          ) : (
            props.approvals.map((approval) => {
              const meta = readApprovalRequestMeta(approval);
              const isSelected = approval.id === props.selectedApprovalId;

              return (
                <Link
                  className={`task-item ${isSelected ? "task-item-selected" : ""}`}
                  key={approval.id}
                  params={{ approvalId: approval.id }}
                  to="/approvals/$approvalId"
                >
                  <span>
                    <strong>{meta.task_title ?? approval.requested_action}</strong>
                    <small>
                      {(meta.repo_name ?? approval.approval_type) + " · " + approval.approval_type}
                    </small>
                  </span>
                  <span className="chip">{approval.approval_type}</span>
                </Link>
              );
            })
          )}
        </div>

        <div className="detail-card detail-card-stack approval-detail">
          <ApprovalDetailCard
            approval={props.selectedApproval}
            onApprove={props.onApprove}
            onReject={props.onReject}
          />
        </div>
      </div>
    </article>
  );
}

function ApprovalDetailCard(props: {
  approval: ApprovalRecord | null;
  onApprove: (approvalId: string, scope: ApprovalScope | null) => Promise<void>;
  onReject: (approvalId: string) => Promise<void>;
}) {
  if (!props.approval) {
    return (
      <p className="empty-state">
        Select a pending approval to inspect the requested action and resume the task.
      </p>
    );
  }

  const meta = readApprovalRequestMeta(props.approval);

  return (
    <>
      <div className="detail-row">
        <span className="chip">{props.approval.approval_type}</span>
        <span className="chip chip-soft">{props.approval.created_at}</span>
      </div>
      <p>{props.approval.requested_action}</p>
      <dl className="detail-grid">
        <div>
          <dt>Repository</dt>
          <dd>{meta.repo_name ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Task</dt>
          <dd>{meta.task_title ?? props.approval.task_id}</dd>
        </div>
      </dl>

      {props.approval.approval_type === "risky_bash" && meta.command ? (
        <pre className="command-preview">
          <code>{meta.command}</code>
        </pre>
      ) : null}

      <div className="approval-actions">
        {props.approval.approval_type === "risky_bash" ? (
          approvalScopes.map((scope) => (
            <button
              className="solid-button"
              key={scope}
              onClick={() => void props.onApprove(props.approval!.id, scope)}
              type="button"
            >
              {renderApprovalScopeLabel(scope)}
            </button>
          ))
        ) : (
          <button
            className="solid-button"
            onClick={() => void props.onApprove(props.approval!.id, null)}
            type="button"
          >
            Approve
          </button>
        )}
        <button
          className="ghost-button"
          onClick={() => void props.onReject(props.approval!.id)}
          type="button"
        >
          Reject
        </button>
      </div>
    </>
  );
}
