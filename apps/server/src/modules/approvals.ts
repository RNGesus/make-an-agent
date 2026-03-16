import { apiRouteCatalog } from "shared";

export const approvalsModule = {
  name: "approvals",
  routes: apiRouteCatalog.filter((route) => route.path.startsWith("/api/approvals")),
  backing_tables: ["approvals", "audit_events"],
  services: ["list_pending_approvals", "approve_action", "reject_action"],
};
