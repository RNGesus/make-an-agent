import { createFileRoute } from "@tanstack/react-router";
import { ReposDashboardPage } from "../../pages/repos-dashboard-page";

export const Route = createFileRoute("/repos/$repoId")({
  component: RepoRouteComponent,
});

function RepoRouteComponent() {
  const { repoId } = Route.useParams();

  return <ReposDashboardPage repoId={repoId} />;
}
