import type { RepositoryPolicyRecord } from "shared";

export type PolicyAction =
  | { kind: "read" }
  | { kind: "edit" }
  | { kind: "bash"; command: string; risky?: boolean }
  | { kind: "git_write" }
  | { kind: "pull_request" };

export interface PolicyDecision {
  allowed: boolean;
  requires_approval: boolean;
  reason: string;
}

function commandMatchesAllowedPattern(command: string, patterns: readonly string[]) {
  if (patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => new RegExp(pattern).test(command));
}

export function evaluatePolicyAction(
  policy: RepositoryPolicyRecord,
  action: PolicyAction,
): PolicyDecision {
  switch (action.kind) {
    case "read":
      return {
        allowed: policy.allow_read,
        requires_approval: false,
        reason: policy.allow_read
          ? "Read access is enabled for this repository."
          : "Read access is disabled by repo policy.",
      };
    case "edit":
      return {
        allowed: policy.allow_edit,
        requires_approval: policy.allow_edit && policy.approval_required_for_edit,
        reason: policy.allow_edit
          ? "Edits are allowed but may require approval."
          : "Edit actions are blocked by repo policy.",
      };
    case "bash": {
      const safeMatch = commandMatchesAllowedPattern(action.command, policy.safe_command_patterns);
      const allowed = policy.allow_bash && (safeMatch || !action.risky);

      return {
        allowed,
        requires_approval:
          allowed &&
          (!safeMatch || Boolean(action.risky)) &&
          policy.approval_required_for_risky_bash,
        reason: allowed
          ? "Bash action is permitted within the repo policy."
          : "Bash command is outside the allowed policy patterns.",
      };
    }
    case "git_write":
      return {
        allowed: policy.allow_git_write,
        requires_approval: policy.allow_git_write && policy.approval_required_for_commit,
        reason: policy.allow_git_write
          ? "Git write access is enabled for this repo."
          : "Git write access is disabled by repo policy.",
      };
    case "pull_request":
      return {
        allowed: policy.allow_pr_create,
        requires_approval: policy.allow_pr_create && policy.approval_required_for_pr,
        reason: policy.allow_pr_create
          ? "Pull request creation is enabled for this repo."
          : "Pull request creation is disabled by repo policy.",
      };
  }
}
