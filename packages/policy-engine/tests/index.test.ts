import { expect, test } from "vite-plus/test";
import type { RepositoryPolicyRecord } from "shared";
import { evaluatePolicyAction } from "../src/index.ts";

const basePolicy: RepositoryPolicyRecord = {
  repo_id: "repo_1",
  autonomy_mode: "approve-writes",
  allowed_root: "/srv/agent-workspaces/example",
  allow_read: true,
  allow_edit: true,
  allow_bash: true,
  allow_git_write: true,
  allow_pr_create: true,
  safe_command_patterns: ["^git status$", "^vp test$"],
  approval_required_for_edit: true,
  approval_required_for_commit: true,
  approval_required_for_pr: true,
  approval_required_for_risky_bash: true,
  cheap_provider: "openai",
  cheap_model: "gpt-5-mini",
  strong_provider: "openai",
  strong_model: "gpt-5.4",
  classifier_provider: "openai",
  classifier_model: "gpt-5-mini",
  max_escalations: 1,
  max_task_budget_usd: 10,
};

test("requires approval for allowed edits when the policy says so", () => {
  const decision = evaluatePolicyAction(basePolicy, { kind: "edit" });

  expect(decision.allowed).toBe(true);
  expect(decision.requires_approval).toBe(true);
});

test("allows safe bash commands without blocking them", () => {
  const decision = evaluatePolicyAction(basePolicy, { kind: "bash", command: "git status" });

  expect(decision.allowed).toBe(true);
});

test("marks risky bash commands as approval-gated instead of blocking them outright", () => {
  const decision = evaluatePolicyAction(basePolicy, {
    kind: "bash",
    command: "rm -rf tmp",
    risky: true,
  });

  expect(decision.allowed).toBe(true);
  expect(decision.requires_approval).toBe(true);
  expect(decision.reason).toContain("requires approval");
});

test("fails closed when a safe command pattern is invalid", () => {
  const decision = evaluatePolicyAction(
    {
      ...basePolicy,
      safe_command_patterns: ["[invalid"],
    },
    {
      kind: "bash",
      command: "git status",
    },
  );

  expect(decision.allowed).toBe(false);
  expect(decision.reason).toContain("invalid safe-command pattern");
});
