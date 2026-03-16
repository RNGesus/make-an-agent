import { apiRouteCatalog } from "shared";

export const tasksModule = {
  name: "tasks",
  routes: apiRouteCatalog.filter((route) => route.path.startsWith("/api/tasks")),
  backing_tables: ["tasks", "task_artifacts", "audit_events"],
  services: ["create_task", "route_task", "persist_artifacts", "capture_diff_context"],
};
