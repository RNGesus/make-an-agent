import { connectionPragmas, initialMigration, schemaTables } from "db";
import { buildPullRequestDraft } from "github";
import { createPiExecutionEnvelope } from "pi-runner";
import { evaluatePolicyAction } from "policy-engine";
import { deliveryMilestones } from "shared";
import { decideTaskRoute } from "task-router";
import { defaultServerConfig } from "./config.ts";
import { createServerApp } from "./app.ts";
import { approvalsModule } from "./modules/approvals.ts";
import { repositoriesModule } from "./modules/repositories.ts";
import { tasksModule } from "./modules/tasks.ts";

export const serverScaffold = {
  app: "pi-remote-control-server",
  config: defaultServerConfig,
  migration: initialMigration,
  connection_pragmas: connectionPragmas,
  modules: [repositoriesModule, tasksModule, approvalsModule],
  packages: {
    schema_tables: schemaTables.map((table) => table.name),
    task_router: decideTaskRoute,
    policy_engine: evaluatePolicyAction,
    pi_runner: createPiExecutionEnvelope,
    github: buildPullRequestDraft,
  },
  milestones: deliveryMilestones,
};

export { createServerApp };
