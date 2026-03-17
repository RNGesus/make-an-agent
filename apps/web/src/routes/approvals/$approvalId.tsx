import { createFileRoute } from "@tanstack/react-router";
import { ApprovalsPage } from "../../pages/approvals-page";

export const Route = createFileRoute("/approvals/$approvalId")({
  component: ApprovalDetailRouteComponent,
});

function ApprovalDetailRouteComponent() {
  const { approvalId } = Route.useParams();

  return <ApprovalsPage approvalId={approvalId} />;
}
