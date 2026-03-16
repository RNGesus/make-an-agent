import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

test("task creation persists routing decisions and supports list and detail views", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-alpha");
  const app = createApp(workspaceRoot);
  const repoId = await registerRepository(app, repoRoot);

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        title: "Implement routing persistence",
        user_prompt: "Implement task intake persistence and cover it with tests",
        goal_type: "implement",
        expected_file_count: 4,
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    task: {
      id: string;
      goal_type: string;
      routing_tier: string;
      routing_reason: string;
      classifier_score: number | null;
    };
    repository: { id: string; name: string };
  };

  expect(createResponse.status).toBe(201);
  expect(created.task).toMatchObject({
    goal_type: "implement",
    routing_tier: "strong",
  });
  expect(created.task.routing_reason).toContain("strong-tier");
  expect(created.task.classifier_score).toBeNull();
  expect(created.repository).toMatchObject({ id: repoId, name: "tasks-alpha" });

  const listResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks?repo_id=${encodeURIComponent(repoId)}`),
  );
  const listPayload = (await listResponse.json()) as {
    tasks: Array<{ task: { id: string }; repository: { id: string } }>;
  };

  expect(listResponse.status).toBe(200);
  expect(listPayload.tasks).toHaveLength(1);
  expect(listPayload.tasks[0]).toMatchObject({
    task: { id: created.task.id },
    repository: { id: repoId },
  });

  const detailResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${created.task.id}`),
  );
  const detailPayload = (await detailResponse.json()) as {
    task: { id: string; title: string };
    repository: { default_branch: string };
  };

  expect(detailResponse.status).toBe(200);
  expect(detailPayload).toMatchObject({
    task: { id: created.task.id, title: "Implement routing persistence" },
    repository: { default_branch: "main" },
  });
});

test("ambiguous tasks persist classifier metadata when routing escalates", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-beta");
  const app = createApp(workspaceRoot);
  const repoId = await registerRepository(app, repoRoot);

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        user_prompt: "Take a look at the repo and tell me where to start",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    task: {
      title: string;
      goal_type: string;
      routing_tier: string;
      routing_reason: string;
      classifier_score: number | null;
      classifier_confidence: number | null;
    };
  };

  expect(createResponse.status).toBe(201);
  expect(created.task.title).toContain("Take a look at the repo");
  expect(created.task.goal_type).toBe("question");
  expect(created.task.routing_tier).toBe("strong");
  expect(created.task.routing_reason).toContain("escalated");
  expect(created.task.classifier_score).not.toBeNull();
  expect(created.task.classifier_confidence).toBeLessThan(0.65);
});

test("read-only tasks auto-execute and persist session artifacts", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-gamma");
  const app = createApp(workspaceRoot);
  const repoId = await registerRepository(app, repoRoot);

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        title: "Summarize the repository",
        user_prompt: "Explain what this repository contains and how to start reading it",
        goal_type: "question",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    task: { status: string; pi_session_id: string | null };
    artifacts: Array<{ artifact_type: string; summary: string; payload_json: string }>;
    audit_events: Array<{ event_type: string }>;
  };

  expect(createResponse.status).toBe(201);
  expect(created.task.status).toBe("completed");
  expect(created.task.pi_session_id).toContain("pi-rpc:");
  expect(created.artifacts).toHaveLength(4);
  expect(created.artifacts.map((artifact) => artifact.artifact_type).sort()).toEqual([
    "changed_files",
    "diff_summary",
    "execution_notes",
    "final_answer",
  ]);
  expect(
    created.artifacts.find((artifact) => artifact.artifact_type === "final_answer")?.summary,
  ).toContain("Mock RPC pi session");
  expect(created.audit_events.map((event) => event.event_type)).toContain(
    "task.execution.completed",
  );
});

test("read-only execution does not attribute pre-existing dirty changes to the task", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-delta");
  const app = createApp(workspaceRoot);
  const repoId = await registerRepository(app, repoRoot);

  writeFileSync(join(repoRoot, "README.md"), "# tasks-delta\nDirty before execution\n");

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        user_prompt: "Explain the repository layout",
        goal_type: "question",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    artifacts: Array<{ artifact_type: string; summary: string; payload_json: string }>;
  };
  const changedFiles = JSON.parse(
    created.artifacts.find((artifact) => artifact.artifact_type === "changed_files")
      ?.payload_json ?? "{}",
  ) as {
    files?: Array<{ path: string; status: string }>;
  };

  expect(createResponse.status).toBe(201);
  expect(changedFiles.files ?? []).toEqual([]);
  expect(
    created.artifacts.find((artifact) => artifact.artifact_type === "diff_summary")?.summary,
  ).toContain("already dirty before execution");
});

test("task creation rejects unknown repositories", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const app = createApp(workspaceRoot);

  const response = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: "missing-repo",
        user_prompt: "Explain the setup",
      }),
    }),
  );
  const payload = (await response.json()) as { error: string };

  expect(response.status).toBe(404);
  expect(payload.error).toContain("missing-repo");
});

function createApp(workspaceRoot: string) {
  const app = createServerApp({
    workspace_parent_dir: workspaceRoot,
    database_path: join(workspaceRoot, ".data", "control-plane.sqlite"),
  });

  apps.push(app);
  return app;
}

async function registerRepository(app: ReturnType<typeof createServerApp>, repoRoot: string) {
  const response = await app.handleRequest(
    new Request("http://localhost/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root_path: repoRoot }),
    }),
  );
  const payload = (await response.json()) as { repository: { id: string } };

  return payload.repository.id;
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
