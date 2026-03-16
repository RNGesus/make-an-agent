import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vite-plus/test";
import { executePiTask } from "../src/index.ts";

test("dirty files modified again during execution are still attributed to the task", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-runner-"));
  const repoRoot = createGitRepository(workspaceRoot, "runner-alpha");
  const readmePath = join(repoRoot, "README.md");

  writeFileSync(readmePath, "# runner-alpha\nDirty before execution\n");

  const result = await executePiTask(
    {
      mode: "rpc",
      repo: {
        id: "repo-1",
        name: "runner-alpha",
        root_path: repoRoot,
        default_branch: "main",
      },
      policy: {
        allowed_root: repoRoot,
        autonomy_mode: "approve-writes",
        max_task_budget_usd: 10,
      },
      task: {
        id: "task-1",
        title: "Summarize repo",
        user_prompt: "Explain the repository layout",
        goal_type: "question",
      },
      routing_tier: "cheap",
      model_profile: {
        provider: "openai",
        model: "gpt-5-mini",
      },
    },
    {
      execute() {
        writeFileSync(readmePath, "# runner-alpha\nDirty before execution\nChanged during task\n");

        return {
          final_answer: "Done.",
        };
      },
    },
  );
  const changedFiles = result.artifacts.find(
    (artifact) => artifact.artifact_type === "changed_files",
  )?.payload as {
    files?: Array<{ path: string; status: string }>;
  };
  const diffSummary = result.artifacts.find(
    (artifact) => artifact.artifact_type === "diff_summary",
  );
  const diffPayload = diffSummary?.payload as { patch_excerpt?: string } | undefined;

  expect(changedFiles.files).toEqual([{ path: "README.md", status: "M" }]);
  expect(diffSummary?.summary).toContain("already dirty before execution");
  expect(diffPayload?.patch_excerpt).toBe("");
});

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
