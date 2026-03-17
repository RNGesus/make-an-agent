import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ApprovalPanel } from "../components/approval-panel";
import { useOperatorApp } from "../lib/operator-app";

export function ApprovalsPage(props: { approvalId?: string }) {
  const navigate = useNavigate();
  const { approvals, rejectApproval, resolveApproval } = useOperatorApp();
  const selectedApproval =
    approvals.find((approval) => approval.id === props.approvalId) ?? approvals[0] ?? null;

  useEffect(() => {
    if (!props.approvalId && approvals[0]) {
      void navigate({
        params: { approvalId: approvals[0].id },
        replace: true,
        to: "/approvals/$approvalId",
      });
    }
  }, [approvals, navigate, props.approvalId]);

  return (
    <ApprovalPanel
      approvals={approvals}
      onApprove={async (approvalId, scope) => {
        const task = await resolveApproval(approvalId, scope);

        if (task) {
          void navigate({
            params: {
              repoId: task.repository.id,
              taskId: task.task.id,
            },
            to: "/repos/$repoId/tasks/$taskId",
          });
        }
      }}
      onReject={async (approvalId) => {
        const task = await rejectApproval(approvalId);

        if (task) {
          void navigate({
            params: {
              repoId: task.repository.id,
              taskId: task.task.id,
            },
            to: "/repos/$repoId/tasks/$taskId",
          });
        }
      }}
      selectedApproval={selectedApproval}
      selectedApprovalId={selectedApproval?.id ?? null}
    />
  );
}
