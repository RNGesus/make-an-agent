import type { PiRunnerMode } from "pi-runner";

export interface ServerConfig {
  workspace_parent_dir: string;
  database_path: string;
  default_autonomy_mode: string;
  queue_mode: "in-process";
  allowed_origins: string[];
  http_host: string;
  http_port: number;
  web_dist_dir: string;
  pi_runner_mode: PiRunnerMode;
}

export const defaultServerConfig: ServerConfig = {
  workspace_parent_dir: "/srv/agent-workspaces",
  database_path: ".data/pi-remote-control.sqlite",
  default_autonomy_mode: "approve-writes",
  queue_mode: "in-process",
  allowed_origins: [],
  http_host: "127.0.0.1",
  http_port: 4310,
  web_dist_dir: "apps/web/dist",
  pi_runner_mode: "rpc",
};

export function readServerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<ServerConfig> {
  return {
    workspace_parent_dir:
      readNonEmptyString(env.WORKSPACE_PARENT_DIR) ?? defaultServerConfig.workspace_parent_dir,
    database_path:
      readNonEmptyString(env.CONTROL_PLANE_DATABASE_PATH) ?? defaultServerConfig.database_path,
    default_autonomy_mode:
      readNonEmptyString(env.DEFAULT_AUTONOMY_MODE) ?? defaultServerConfig.default_autonomy_mode,
    allowed_origins:
      readCommaSeparatedStrings(env.ALLOWED_ORIGINS) ?? defaultServerConfig.allowed_origins,
    http_host: readNonEmptyString(env.HOST) ?? defaultServerConfig.http_host,
    http_port: readInteger(env.PORT) ?? defaultServerConfig.http_port,
    web_dist_dir: readNonEmptyString(env.WEB_DIST_DIR) ?? defaultServerConfig.web_dist_dir,
    pi_runner_mode: readPiRunnerMode(env.PI_RUNNER_MODE) ?? defaultServerConfig.pi_runner_mode,
  };
}

function readNonEmptyString(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function readCommaSeparatedStrings(value: string | undefined) {
  const trimmed = readNonEmptyString(value);

  return trimmed
    ? trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : null;
}

function readInteger(value: string | undefined) {
  const trimmed = readNonEmptyString(value);

  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);

  return Number.isInteger(parsed) ? parsed : null;
}

function readPiRunnerMode(value: string | undefined): PiRunnerMode | null {
  return value === "sdk" || value === "rpc" ? value : null;
}
