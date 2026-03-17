import { createFileRoute } from "@tanstack/react-router";
import { ReposDashboardPage } from "../../pages/repos-dashboard-page";

export const Route = createFileRoute("/repos/")({
  component: ReposRouteComponent,
});

function ReposRouteComponent() {
  return <ReposDashboardPage />;
}
