export interface ApiRouteDefinition {
  method: "GET" | "POST" | "PATCH";
  path: string;
  feature: string;
}

export const apiRouteCatalog: readonly ApiRouteDefinition[] = [
  { method: "GET", path: "/api/repos", feature: "list registered repositories" },
  { method: "POST", path: "/api/repos/scan", feature: "discover candidate repositories" },
  { method: "POST", path: "/api/repos", feature: "register repository" },
  { method: "GET", path: "/api/repos/:id", feature: "show repository detail" },
  { method: "PATCH", path: "/api/repos/:id/policy", feature: "update repository policy" },
  { method: "GET", path: "/api/tasks", feature: "list tasks" },
  { method: "POST", path: "/api/tasks", feature: "create task" },
  { method: "GET", path: "/api/tasks/:id", feature: "show task detail" },
  { method: "POST", path: "/api/tasks/:id/retry", feature: "retry task execution" },
  { method: "POST", path: "/api/tasks/:id/commit", feature: "request commit action" },
  { method: "POST", path: "/api/tasks/:id/pr", feature: "create pull request" },
  { method: "GET", path: "/api/tasks/:id/diff", feature: "fetch task diff" },
  { method: "GET", path: "/api/approvals", feature: "list approval queue" },
  { method: "POST", path: "/api/approvals/:id/approve", feature: "approve pending action" },
  { method: "POST", path: "/api/approvals/:id/reject", feature: "reject pending action" },
];
