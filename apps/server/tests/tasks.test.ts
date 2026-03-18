import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vite-plus/test";
import type { GitHubPullRequestCreator } from "github";
import { PiCommandApprovalRequiredError, type PiExecutor } from "pi-runner";
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
  ).toContain("Stub RPC pi session");
  expect(created.audit_events.map((event) => event.event_type)).toContain(
    "task.execution.completed",
  );
});

test("write-capable tasks pause for edit approval and resume after approval", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-epsilon");
  let executionCount = 0;
  const app = createApp(workspaceRoot, {
    piExecute(envelope) {
      executionCount += 1;

      return {
        final_answer: `Stub ${envelope.mode.toUpperCase()} pi session for '${envelope.task_title}' completed.`,
        session_id: `pi-${envelope.mode}:${envelope.task_id}`,
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        title: "Implement edit approval",
        user_prompt: "Implement the requested server change and update tests",
        goal_type: "implement",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    task: { id: string; status: string };
    approvals: Array<{ id: string; approval_type: string; status: string }>;
    audit_events: Array<{ event_type: string }>;
  };

  expect(createResponse.status).toBe(201);
  expect(created.task.status).toBe("awaiting_approval");
  expect(created.approvals).toHaveLength(1);
  expect(created.approvals[0]).toMatchObject({ approval_type: "edit", status: "pending" });
  expect(created.audit_events.map((event) => event.event_type)).toContain(
    "task.approval.requested",
  );
  expect(executionCount).toBe(0);

  const approvalsResponse = await app.handleRequest(new Request("http://localhost/api/approvals"));
  const approvalsPayload = (await approvalsResponse.json()) as {
    approvals: Array<{ id: string; task_id: string; status: string }>;
  };

  expect(approvalsResponse.status).toBe(200);
  expect(approvalsPayload.approvals).toEqual([
    expect.objectContaining({
      id: created.approvals[0]?.id,
      task_id: created.task.id,
      status: "pending",
    }),
  ]);

  const approveResponse = await app.handleRequest(
    new Request(`http://localhost/api/approvals/${created.approvals[0]?.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decided_by: "Operator" }),
    }),
  );
  const approved = (await approveResponse.json()) as {
    approval: { status: string; decided_by: string | null };
    task: {
      task: { status: string; pi_session_id: string | null };
      approvals: Array<{ status: string }>;
      audit_events: Array<{ event_type: string }>;
    };
  };

  expect(approveResponse.status).toBe(200);
  expect(approved.approval).toMatchObject({ status: "approved", decided_by: "Operator" });
  expect(approved.task.task.status).toBe("completed");
  expect(approved.task.task.pi_session_id).toContain("pi-");
  expect(approved.task.approvals.map((approval) => approval.status)).toContain("approved");
  expect(approved.task.audit_events.map((event) => event.event_type)).toContain(
    "task.approval.approved",
  );
  expect(executionCount).toBe(1);
});

test("rejecting an approval marks the task as failed without executing it", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-zeta");
  let executionCount = 0;
  const app = createApp(workspaceRoot, {
    piExecute(envelope) {
      executionCount += 1;

      return {
        final_answer: `Stub ${envelope.mode.toUpperCase()} pi session for '${envelope.task_title}' completed.`,
        session_id: `pi-${envelope.mode}:${envelope.task_id}`,
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        user_prompt: "Implement the requested refactor",
        goal_type: "refactor",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    task: { id: string; status: string };
    approvals: Array<{ id: string }>;
  };

  expect(created.task.status).toBe("awaiting_approval");

  const rejectResponse = await app.handleRequest(
    new Request(`http://localhost/api/approvals/${created.approvals[0]?.id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decided_by: "Operator" }),
    }),
  );
  const rejected = (await rejectResponse.json()) as {
    approval: { status: string; decided_by: string | null };
    task: {
      task: { status: string };
      audit_events: Array<{ event_type: string }>;
    };
  };

  expect(rejectResponse.status).toBe(200);
  expect(rejected.approval).toMatchObject({ status: "rejected", decided_by: "Operator" });
  expect(rejected.task.task.status).toBe("failed");
  expect(rejected.task.audit_events.map((event) => event.event_type)).toContain(
    "task.approval.rejected",
  );
  expect(executionCount).toBe(0);
});

test("only one concurrent approval request can resume a task", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-eta");
  let executionCount = 0;
  const app = createApp(workspaceRoot, {
    piExecute(envelope) {
      executionCount += 1;

      return {
        final_answer: `Stub ${envelope.mode.toUpperCase()} pi session for '${envelope.task_title}' completed.`,
        session_id: `pi-${envelope.mode}:${envelope.task_id}`,
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        user_prompt: "Implement the requested feature",
        goal_type: "implement",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    approvals: Array<{ id: string }>;
  };
  const approvalId = created.approvals[0]?.id;

  const [first, second] = await Promise.all([
    app.handleRequest(
      new Request(`http://localhost/api/approvals/${approvalId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    ),
    app.handleRequest(
      new Request(`http://localhost/api/approvals/${approvalId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    ),
  ]);

  expect([first.status, second.status].sort((left, right) => left - right)).toEqual([200, 409]);
  expect(executionCount).toBe(1);
});

test("concurrent approve and retry requests only execute the task once", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-theta");
  let executionCount = 0;
  const app = createApp(workspaceRoot, {
    piExecute(envelope) {
      executionCount += 1;

      return {
        final_answer: `Stub ${envelope.mode.toUpperCase()} pi session for '${envelope.task_title}' completed.`,
        session_id: `pi-${envelope.mode}:${envelope.task_id}`,
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        user_prompt: "Implement the requested feature",
        goal_type: "implement",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    task: { id: string };
    approvals: Array<{ id: string }>;
  };

  const [approveResponse, retryResponse] = await Promise.all([
    app.handleRequest(
      new Request(`http://localhost/api/approvals/${created.approvals[0]?.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    ),
    app.handleRequest(
      new Request(`http://localhost/api/tasks/${created.task.id}/retry`, {
        method: "POST",
      }),
    ),
  ]);

  expect(approveResponse.status).toBe(200);
  expect(retryResponse.status).toBe(200);
  expect(executionCount).toBe(1);
});

test("concurrent retries after rejection recreate only one pending approval", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-iota");
  let executionCount = 0;
  const app = createApp(workspaceRoot, {
    piExecute(envelope) {
      executionCount += 1;

      return {
        final_answer: `Stub ${envelope.mode.toUpperCase()} pi session for '${envelope.task_title}' completed.`,
        session_id: `pi-${envelope.mode}:${envelope.task_id}`,
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        user_prompt: "Implement the requested feature",
        goal_type: "implement",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    task: { id: string };
    approvals: Array<{ id: string }>;
  };

  await app.handleRequest(
    new Request(`http://localhost/api/approvals/${created.approvals[0]?.id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );

  await Promise.all([
    app.handleRequest(
      new Request(`http://localhost/api/tasks/${created.task.id}/retry`, {
        method: "POST",
      }),
    ),
    app.handleRequest(
      new Request(`http://localhost/api/tasks/${created.task.id}/retry`, {
        method: "POST",
      }),
    ),
  ]);

  const detailResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${created.task.id}`),
  );
  const detail = (await detailResponse.json()) as {
    task: { status: string };
    approvals: Array<{ status: string }>;
  };

  expect(detail.task.status).toBe("awaiting_approval");
  expect(detail.approvals.filter((approval) => approval.status === "pending")).toHaveLength(1);
  expect(executionCount).toBe(0);
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

test("risky bash approvals require a scope and resume the task after approval", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-kappa");
  let executionCount = 0;
  let registeredRepoId = "";
  const app = createApp(workspaceRoot, {
    piExecute(envelope) {
      executionCount += 1;

      if (executionCount === 1) {
        throw new PiCommandApprovalRequiredError("Allow the risky bash command for this task.", {
          repo_id: registeredRepoId,
          repo_name: envelope.repo_name,
          task_id: envelope.task_id,
          task_title: envelope.task_title,
          goal_type: envelope.task_goal_type,
          routing_tier: envelope.routing_tier,
          command: "git push origin HEAD",
          command_fingerprint: "fingerprint-1",
          session_key: envelope.execution_key,
        });
      }

      return {
        final_answer: `Stub ${envelope.mode.toUpperCase()} pi session for '${envelope.task_title}' completed.`,
        session_id: `pi-${envelope.mode}:${envelope.task_id}`,
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);
  registeredRepoId = repoId;

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        user_prompt: "Inspect the branch and report the current status",
        goal_type: "question",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    task: { status: string };
    approvals: Array<{ id: string; approval_type: string; status: string }>;
  };

  expect(createResponse.status).toBe(201);
  expect(created.task.status).toBe("awaiting_approval");
  expect(created.approvals[0]).toMatchObject({ approval_type: "risky_bash", status: "pending" });

  const missingScopeResponse = await app.handleRequest(
    new Request(`http://localhost/api/approvals/${created.approvals[0]?.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  const missingScopePayload = (await missingScopeResponse.json()) as { error: string };

  expect(missingScopeResponse.status).toBe(400);
  expect(missingScopePayload.error).toContain("require a scope");

  const approveResponse = await app.handleRequest(
    new Request(`http://localhost/api/approvals/${created.approvals[0]?.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "session" }),
    }),
  );
  const approved = (await approveResponse.json()) as {
    approval: { status: string; resolution_payload_json: string };
    task: { task: { status: string } };
  };

  expect(approveResponse.status).toBe(200);
  expect(approved.approval.status).toBe("approved");
  expect(JSON.parse(approved.approval.resolution_payload_json)).toEqual({ scope: "session" });
  expect(approved.task.task.status).toBe("completed");
  expect(executionCount).toBe(2);
});

test("write tasks create a task branch and expose a live diff endpoint", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-lambda");
  const app = createApp(workspaceRoot, {
    piExecute(envelope) {
      writeFileSync(join(repoRoot, "README.md"), "# tasks-lambda\nTask branch output\n");

      return {
        final_answer: `Stub ${envelope.mode.toUpperCase()} pi session for '${envelope.task_title}' completed.`,
        session_id: `pi-${envelope.mode}:${envelope.task_id}`,
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        title: "Implement branch capture",
        user_prompt: "Implement the requested server change",
        goal_type: "implement",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    task: { id: string };
    approvals: Array<{ id: string }>;
  };

  const approveResponse = await app.handleRequest(
    new Request(`http://localhost/api/approvals/${created.approvals[0]?.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
  const approved = (await approveResponse.json()) as {
    task: { task: { branch_name: string | null; status: string } };
  };

  expect(approveResponse.status).toBe(200);
  expect(approved.task.task.status).toBe("completed");
  expect(approved.task.task.branch_name).toContain("task/");

  const diffResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${created.task.id}/diff`),
  );
  const diff = (await diffResponse.json()) as {
    branch_name: string | null;
    changed_files: Array<{ path: string; status: string }>;
    current_branch: string | null;
    has_changes: boolean;
    patch: string;
  };

  expect(diffResponse.status).toBe(200);
  expect(diff.branch_name).toBe(approved.task.task.branch_name);
  expect(diff.current_branch).toBe(approved.task.task.branch_name);
  expect(diff.has_changes).toBe(true);
  expect(diff.changed_files).toEqual([{ path: "README.md", status: "M" }]);
  expect(diff.patch).toContain("Task branch output");
});

test("commit requests can require approval and execute after approval", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-mu");
  const app = createApp(workspaceRoot, {
    piExecute(envelope) {
      writeFileSync(join(repoRoot, "README.md"), "# tasks-mu\nCommitted after approval\n");

      return {
        final_answer: `Stub ${envelope.mode.toUpperCase()} pi session for '${envelope.task_title}' completed.`,
        session_id: `pi-${envelope.mode}:${envelope.task_id}`,
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  await updatePolicy(app, repoId, { autonomy_mode: "approve-commits" });

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        title: "Implement commit approvals",
        user_prompt: "Implement the requested repository change",
        goal_type: "implement",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    task: { id: string };
    approvals: Array<{ id: string }>;
  };

  await app.handleRequest(
    new Request(`http://localhost/api/approvals/${created.approvals[0]?.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );

  const commitResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${created.task.id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Commit generated task changes" }),
    }),
  );
  const commitRequested = (await commitResponse.json()) as {
    approval: { id: string; approval_type: string; status: string } | null;
    task: { task: { status: string } };
  };

  expect(commitResponse.status).toBe(200);
  expect(commitRequested.approval).toMatchObject({
    approval_type: "commit",
    status: "pending",
  });
  expect(commitRequested.task.task.status).toBe("completed");

  const approveCommitResponse = await app.handleRequest(
    new Request(`http://localhost/api/approvals/${commitRequested.approval?.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
  const approvedCommit = (await approveCommitResponse.json()) as {
    approval: { status: string };
    task: {
      artifacts: Array<{ artifact_type: string; payload_json: string }>;
      task: { status: string };
    };
  };

  expect(approveCommitResponse.status).toBe(200);
  expect(approvedCommit.approval.status).toBe("approved");
  expect(approvedCommit.task.task.status).toBe("completed");
  expect(
    approvedCommit.task.artifacts.find((artifact) => artifact.artifact_type === "commit_metadata"),
  ).toBeTruthy();

  const diffResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${created.task.id}/diff`),
  );
  const diff = (await diffResponse.json()) as { has_changes: boolean };

  expect(diffResponse.status).toBe(200);
  expect(diff.has_changes).toBe(false);
});

test("trusted task branches can create a real GitHub draft pull request after commit", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-nu");
  const app = createApp(workspaceRoot, {
    githubCreatePullRequest: async () => ({
      draft: true,
      head_sha: "abcdef1234567890",
      number: 27,
      state: "open",
      url: "https://github.com/test/tasks-nu/pull/27",
    }),
    githubToken: "test-token",
    piExecute(envelope) {
      writeFileSync(join(repoRoot, "README.md"), "# tasks-nu\nReady for PR creation\n");

      return {
        final_answer: `Stub ${envelope.mode.toUpperCase()} pi session for '${envelope.task_title}' completed.`,
        session_id: `pi-${envelope.mode}:${envelope.task_id}`,
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  await updatePolicy(app, repoId, { autonomy_mode: "trusted" });

  const createResponse = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        title: "Implement PR creation",
        user_prompt: "Implement the requested repository change",
        goal_type: "implement",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    task: { id: string; status: string };
  };

  expect(createResponse.status).toBe(201);
  expect(created.task.status).toBe("completed");

  const commitResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${created.task.id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Commit trusted task changes" }),
    }),
  );
  const committed = (await commitResponse.json()) as {
    approval: null;
    task: { artifacts: Array<{ artifact_type: string }> };
  };

  expect(commitResponse.status).toBe(200);
  expect(committed.approval).toBeNull();
  expect(committed.task.artifacts.map((artifact) => artifact.artifact_type)).toContain(
    "commit_metadata",
  );

  const prResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${created.task.id}/pr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  const drafted = (await prResponse.json()) as {
    approval: null;
    task: { artifacts: Array<{ artifact_type: string; payload_json: string }> };
  };

  expect(prResponse.status).toBe(200);
  expect(drafted.approval).toBeNull();
  expect(readArtifactPayload(drafted.task.artifacts, "pr_metadata")).toMatchObject({
    draft: true,
    pr_number: 27,
    pr_url: "https://github.com/test/tasks-nu/pull/27",
    provider: "github",
    state: "open",
    status: "open",
    title: "Implement PR creation",
  });
});

test("pull request creation falls back to local draft metadata when the GitHub token is missing", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-xi");
  const app = createApp(workspaceRoot, {
    piExecute() {
      writeFileSync(join(repoRoot, "README.md"), "# tasks-xi\nFallback draft\n");

      return {
        final_answer: "Completed with local fallback.",
        session_id: "pi-rpc:tasks-xi",
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  await updatePolicy(app, repoId, { autonomy_mode: "trusted" });

  const createdTaskId = await createCompletedTask(app, repoId, "Prepare fallback PR");
  await commitTask(app, createdTaskId, "Commit fallback task changes");

  const prResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${createdTaskId}/pr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  const payload = (await prResponse.json()) as {
    approval: null;
    task: {
      artifacts: Array<{ artifact_type: string; payload_json: string }>;
      audit_events: Array<{ event_type: string }>;
    };
  };

  expect(prResponse.status).toBe(200);
  expect(payload.approval).toBeNull();
  expect(readArtifactPayload(payload.task.artifacts, "pr_metadata")).toMatchObject({
    error: "GITHUB_TOKEN is not configured on the server.",
    provider: "local",
    status: "drafted_fallback",
  });
  expect(payload.task.audit_events.map((event) => event.event_type)).toEqual(
    expect.arrayContaining(["task.git.pushed", "task.git.pr_fallback", "task.git.pr_drafted"]),
  );
});

test("pull request creation falls back to local draft metadata when GitHub creation fails", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-omicron");
  const app = createApp(workspaceRoot, {
    githubCreatePullRequest: async () => {
      throw new Error("GitHub API rejected the draft PR.");
    },
    githubToken: "test-token",
    piExecute() {
      writeFileSync(join(repoRoot, "README.md"), "# tasks-omicron\nFallback after API error\n");

      return {
        final_answer: "Completed with GitHub fallback.",
        session_id: "pi-rpc:tasks-omicron",
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  await updatePolicy(app, repoId, { autonomy_mode: "trusted" });

  const createdTaskId = await createCompletedTask(app, repoId, "Prepare errored PR");
  await commitTask(app, createdTaskId, "Commit errored PR task changes");

  const prResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${createdTaskId}/pr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  const payload = (await prResponse.json()) as {
    task: {
      artifacts: Array<{ artifact_type: string; payload_json: string }>;
      audit_events: Array<{ event_type: string }>;
    };
  };

  expect(prResponse.status).toBe(200);
  expect(readArtifactPayload(payload.task.artifacts, "pr_metadata")).toMatchObject({
    error: "GitHub API rejected the draft PR.",
    provider: "local",
    status: "drafted_fallback",
  });
  expect(payload.task.audit_events.map((event) => event.event_type)).toEqual(
    expect.arrayContaining(["task.git.pushed", "task.git.pr_fallback", "task.git.pr_drafted"]),
  );
});

test("approval-gated pull request creation creates a real GitHub PR after approval", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-pi");
  const app = createApp(workspaceRoot, {
    githubCreatePullRequest: async () => ({
      draft: true,
      head_sha: "1234567890abcdef",
      number: 44,
      state: "open",
      url: "https://github.com/test/tasks-pi/pull/44",
    }),
    githubToken: "test-token",
    piExecute() {
      writeFileSync(join(repoRoot, "README.md"), "# tasks-pi\nApproval gated PR\n");

      return {
        final_answer: "Completed with approval-gated PR.",
        session_id: "pi-rpc:tasks-pi",
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  await updatePolicy(app, repoId, {
    autonomy_mode: "trusted",
    approval_required_for_pr: true,
  });

  const createdTaskId = await createCompletedTask(app, repoId, "Create approved PR");
  await commitTask(app, createdTaskId, "Commit approved PR task changes");

  const requestResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${createdTaskId}/pr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  const requested = (await requestResponse.json()) as {
    approval: { id: string; approval_type: string; status: string };
    task: { artifacts: Array<{ artifact_type: string }> };
  };

  expect(requestResponse.status).toBe(200);
  expect(requested.approval).toMatchObject({ approval_type: "pull_request", status: "pending" });
  expect(requested.task.artifacts.map((artifact) => artifact.artifact_type)).not.toContain(
    "pr_metadata",
  );

  const approveResponse = await app.handleRequest(
    new Request(`http://localhost/api/approvals/${requested.approval.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decided_by: "operator" }),
    }),
  );
  const approved = (await approveResponse.json()) as {
    approval: { status: string };
    task: { artifacts: Array<{ artifact_type: string; payload_json: string }> };
  };

  expect(approveResponse.status).toBe(200);
  expect(approved.approval.status).toBe("approved");
  expect(readArtifactPayload(approved.task.artifacts, "pr_metadata")).toMatchObject({
    pr_number: 44,
    provider: "github",
    status: "open",
  });
});

test("pull request creation fails when the task branch cannot be pushed to origin", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-workspaces-"));
  const repoRoot = createGitRepository(workspaceRoot, "tasks-rho", {
    pushUrl: join(workspaceRoot, "missing-remote.git"),
  });
  const app = createApp(workspaceRoot, {
    githubCreatePullRequest: async () => ({
      draft: true,
      head_sha: "should-not-run",
      number: 88,
      state: "open",
      url: "https://github.com/test/tasks-rho/pull/88",
    }),
    githubToken: "test-token",
    piExecute() {
      writeFileSync(join(repoRoot, "README.md"), "# tasks-rho\nPush failure\n");

      return {
        final_answer: "Completed before push failure.",
        session_id: "pi-rpc:tasks-rho",
      };
    },
  });
  const repoId = await registerRepository(app, repoRoot);

  await updatePolicy(app, repoId, { autonomy_mode: "trusted" });

  const createdTaskId = await createCompletedTask(app, repoId, "Fail PR push");
  await commitTask(app, createdTaskId, "Commit push failure task changes");

  const prResponse = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${createdTaskId}/pr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  const payload = (await prResponse.json()) as { error: string };

  expect(prResponse.status).toBe(400);
  expect(payload.error).toContain("Could not push task branch");
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

function createApp(
  workspaceRoot: string,
  options: {
    piExecute?: PiExecutor;
    githubCreatePullRequest?: GitHubPullRequestCreator;
    githubToken?: string | null;
  } = {},
) {
  const app = createServerApp({
    workspace_parent_dir: workspaceRoot,
    database_path: join(workspaceRoot, ".data", "control-plane.sqlite"),
    github_create_pull_request: options.githubCreatePullRequest,
    github_token: options.githubToken ?? null,
    pi_execute: options.piExecute ?? createStubPiExecutor(),
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

async function updatePolicy(
  app: ReturnType<typeof createServerApp>,
  repoId: string,
  patch: Record<string, unknown>,
) {
  const response = await app.handleRequest(
    new Request(`http://localhost/api/repos/${repoId}/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );

  if (response.status !== 200) {
    throw new Error(`Failed to patch repository policy for ${repoId}.`);
  }
}

function createStubPiExecutor(): PiExecutor {
  return (envelope) => ({
    final_answer: `Stub ${envelope.mode.toUpperCase()} pi session for '${envelope.task_title}' completed.`,
    session_id: `pi-${envelope.mode}:${envelope.task_id}`,
  });
}

function createGitRepository(
  workspaceRoot: string,
  name: string,
  options: {
    remoteUrl?: string;
    pushUrl?: string | null;
  } = {},
) {
  const remoteUrl = options.remoteUrl ?? `git@github.com:test/${name}.git`;
  const pushUrl = options.pushUrl ?? createBareGitRemote(workspaceRoot, name);
  const repoRoot = join(workspaceRoot, name);
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, "README.md"), `# ${name}\n`);

  runGit(repoRoot, ["init", "--initial-branch=main"]);
  runGit(repoRoot, ["config", "user.name", "OpenCode Tests"]);
  runGit(repoRoot, ["config", "user.email", "opencode@example.com"]);
  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  runGit(repoRoot, ["remote", "add", "origin", remoteUrl]);
  if (pushUrl) {
    runGit(repoRoot, ["remote", "set-url", "--push", "origin", pushUrl]);
  }

  return repoRoot;
}

function createBareGitRemote(workspaceRoot: string, name: string) {
  const remoteRoot = join(workspaceRoot, `${name}-remote.git`);

  runGit(workspaceRoot, ["init", "--bare", remoteRoot]);

  return remoteRoot;
}

async function createCompletedTask(
  app: ReturnType<typeof createServerApp>,
  repoId: string,
  title: string,
) {
  const response = await app.handleRequest(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        title,
        user_prompt: "Implement the requested repository change",
        goal_type: "implement",
      }),
    }),
  );
  const payload = (await response.json()) as { task: { id: string; status: string } };

  expect(response.status).toBe(201);
  expect(payload.task.status).toBe("completed");

  return payload.task.id;
}

async function commitTask(
  app: ReturnType<typeof createServerApp>,
  taskId: string,
  message: string,
) {
  const response = await app.handleRequest(
    new Request(`http://localhost/api/tasks/${taskId}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  );

  expect(response.status).toBe(200);
}

function readArtifactPayload(
  artifacts: Array<{ artifact_type: string; payload_json: string }>,
  artifactType: string,
) {
  return JSON.parse(
    artifacts.find((artifact) => artifact.artifact_type === artifactType)?.payload_json ?? "{}",
  ) as Record<string, unknown>;
}

function runGit(rootPath: string, args: string[]) {
  const result = spawnSync("git", ["-C", rootPath, ...args], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}
