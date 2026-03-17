import { createFileRoute } from "@tanstack/react-router";
import { ReposDashboardPage } from "../../../../pages/repos-dashboard-page";

export const Route = createFileRoute("/repos/$repoId/tasks/$taskId")({
  component: RepoTaskRouteComponent,
});

function RepoTaskRouteComponent() {
  const { repoId, taskId } = Route.useParams();

  return <ReposDashboardPage repoId={repoId} taskId={taskId} />;
}
