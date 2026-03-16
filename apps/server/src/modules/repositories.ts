import { apiRouteCatalog } from "shared";

export const repositoriesModule = {
  name: "repositories",
  routes: apiRouteCatalog.filter((route) => route.path.startsWith("/api/repos")),
  backing_tables: ["repositories", "repository_policies", "audit_events"],
  services: ["scan_workspace_parent", "register_repository", "update_repository_policy"],
};
