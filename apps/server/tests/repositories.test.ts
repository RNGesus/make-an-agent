import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vite-plus/test";
import { createServerApp } from "../src/app.ts";

const apps: Array<ReturnType<typeof createServerApp>> = [];

afterEach(() => {
  while (apps.length > 0) {
    apps.pop()?.close();
  }
});

test("repo scan discovers immediate child git repositories", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(
    workspaceRoot,
    "alpha",
    "git@github.com:test/alpha.service.git",
  );
  mkdirSync(join(workspaceRoot, "not-a-repo"));

  const app = createApp(workspaceRoot);
  const response = await app.handleRequest(
    new Request("http://localhost/api/repos/scan", { method: "POST" }),
  );
  const payload = (await response.json()) as {
    candidates: Array<{
      name: string;
      root_path: string;
      is_registered: boolean;
      default_branch: string;
      github_repo: string | null;
    }>;
    warning: string | null;
  };

  expect(response.status).toBe(200);
  expect(payload.candidates).toHaveLength(1);
  expect(payload.candidates[0]).toMatchObject({
    name: "alpha",
    root_path: repoRoot,
    is_registered: false,
    default_branch: "main",
    github_repo: "alpha.service",
  });
  expect(payload.warning).toBeNull();
});

test("server bootstrap creates a missing workspace parent directory", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const workspaceRoot = join(tempRoot, "srv", "agent-workspaces");
  const app = createApp(workspaceRoot, join(tempRoot, ".data", "control-plane.sqlite"));

  expect(existsSync(workspaceRoot)).toBe(true);

  const response = await app.handleRequest(
    new Request("http://localhost/api/repos/scan", { method: "POST" }),
  );
  const payload = (await response.json()) as {
    candidates: unknown[];
    warning: string | null;
  };

  expect(response.status).toBe(200);
  expect(payload.candidates).toEqual([]);
  expect(payload.warning).toBeNull();
});

test("repo scan returns a warning when the workspace parent is not a directory", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const workspacePath = join(tempRoot, "workspace-parent");

  writeFileSync(workspacePath, "not a directory");

  const app = createApp(workspacePath, join(tempRoot, ".data", "control-plane.sqlite"));
  const response = await app.handleRequest(
    new Request("http://localhost/api/repos/scan", { method: "POST" }),
  );
  const payload = (await response.json()) as {
    candidates: unknown[];
    warning: string | null;
  };

  expect(response.status).toBe(200);
  expect(payload.candidates).toEqual([]);
  expect(payload.warning).toContain("not a directory");
});

test("repo registration persists repository rows and default policy", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "beta");
  const app = createApp(workspaceRoot);

  const registerResponse = await app.handleRequest(
    new Request("http://localhost/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root_path: repoRoot }),
    }),
  );
  const detail = (await registerResponse.json()) as {
    repository: { id: string; name: string; root_path: string; default_branch: string };
    policy: { repo_id: string; allowed_root: string; allow_edit: boolean; allow_bash: boolean };
  };

  expect(registerResponse.status).toBe(201);
  expect(detail.repository).toMatchObject({
    name: "beta",
    root_path: repoRoot,
    default_branch: "main",
  });
  expect(detail.policy).toMatchObject({
    repo_id: detail.repository.id,
    allowed_root: repoRoot,
    allow_edit: true,
    allow_bash: true,
  });

  const listResponse = await app.handleRequest(new Request("http://localhost/api/repos"));
  const listPayload = (await listResponse.json()) as {
    repositories: Array<{ repository: { id: string }; policy: { repo_id: string } }>;
  };

  expect(listPayload.repositories).toHaveLength(1);
  expect(listPayload.repositories[0]).toMatchObject({
    repository: { id: detail.repository.id },
    policy: { repo_id: detail.repository.id },
  });
});

test("policy patch updates repository policy fields", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "gamma");
  const app = createApp(workspaceRoot);

  const registerResponse = await app.handleRequest(
    new Request("http://localhost/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root_path: repoRoot }),
    }),
  );
  const detail = (await registerResponse.json()) as { repository: { id: string } };

  const patchResponse = await app.handleRequest(
    new Request(`http://localhost/api/repos/${detail.repository.id}/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow_pr_create: true, autonomy_mode: "trusted" }),
    }),
  );
  const patchPayload = (await patchResponse.json()) as {
    policy: { allow_pr_create: boolean; autonomy_mode: string; approval_required_for_pr: boolean };
  };

  expect(patchResponse.status).toBe(200);
  expect(patchPayload.policy).toMatchObject({
    allow_pr_create: true,
    autonomy_mode: "trusted",
    approval_required_for_pr: false,
  });
});

test("registration rejects allowed_root outside the repository", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "delta");
  const externalDir = mkdtempSync(join(tmpdir(), "pi-remote-control-external-"));
  const app = createApp(workspaceRoot);

  const response = await app.handleRequest(
    new Request("http://localhost/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root_path: repoRoot,
        policy: { allowed_root: externalDir },
      }),
    }),
  );
  const payload = (await response.json()) as { error: string };

  expect(response.status).toBe(400);
  expect(payload.error).toContain("must stay inside");
});

test("registration normalizes relative allowed_root inside the repository", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "zeta");
  const nestedDir = join(repoRoot, "subdir");
  mkdirSync(nestedDir);
  const app = createApp(workspaceRoot);

  const response = await app.handleRequest(
    new Request("http://localhost/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root_path: repoRoot,
        policy: { allowed_root: "subdir" },
      }),
    }),
  );
  const payload = (await response.json()) as { policy: { allowed_root: string } };

  expect(response.status).toBe(201);
  expect(payload.policy.allowed_root).toBe(nestedDir);
});

test("policy patch rejects allowed_root outside the repository", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "epsilon");
  const externalDir = mkdtempSync(join(tmpdir(), "pi-remote-control-external-"));
  const app = createApp(workspaceRoot);

  const registerResponse = await app.handleRequest(
    new Request("http://localhost/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root_path: repoRoot }),
    }),
  );
  const detail = (await registerResponse.json()) as { repository: { id: string } };

  const patchResponse = await app.handleRequest(
    new Request(`http://localhost/api/repos/${detail.repository.id}/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed_root: externalDir }),
    }),
  );
  const patchPayload = (await patchResponse.json()) as { error: string };

  expect(patchResponse.status).toBe(400);
  expect(patchPayload.error).toContain("must stay inside");
});

function createApp(
  workspaceRoot: string,
  databasePath = join(workspaceRoot, ".data", "control-plane.sqlite"),
) {
  const app = createServerApp({
    workspace_parent_dir: workspaceRoot,
    database_path: databasePath,
  });

  apps.push(app);
  return app;
}

function createGitRepository(
  workspaceRoot: string,
  name: string,
  remoteUrl = `git@github.com:test/${name}.git`,
) {
  const repoRoot = join(workspaceRoot, name);
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, "README.md"), `# ${name}\n`);

  runGit(repoRoot, ["init", "--initial-branch=main"]);
  runGit(repoRoot, ["config", "user.name", "OpenCode Tests"]);
  runGit(repoRoot, ["config", "user.email", "opencode@example.com"]);
  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  runGit(repoRoot, ["remote", "add", "origin", remoteUrl]);

  return repoRoot;
}

function runGit(rootPath: string, args: string[]) {
  const result = spawnSync("git", ["-C", rootPath, ...args], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}
