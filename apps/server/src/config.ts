export interface ServerConfig {
  workspace_parent_dir: string;
  database_path: string;
  default_autonomy_mode: string;
  queue_mode: "in-process";
  allowed_origins: string[];
}

export const defaultServerConfig: ServerConfig = {
  workspace_parent_dir: "/srv/agent-workspaces",
  database_path: ".data/pi-remote-control.sqlite",
  default_autonomy_mode: "approve-writes",
  queue_mode: "in-process",
  allowed_origins: [],
};
