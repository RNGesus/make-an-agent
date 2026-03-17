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

  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(command);
    } catch {
      return false;
    }
  });
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
      const hasInvalidPattern = policy.safe_command_patterns.some((pattern) => {
        try {
          new RegExp(pattern);
          return false;
        } catch {
          return true;
        }
      });
      const safeMatch = commandMatchesAllowedPattern(action.command, policy.safe_command_patterns);
      const requiresApproval =
        policy.allow_bash &&
        (Boolean(action.risky) || !safeMatch) &&
        policy.approval_required_for_risky_bash;
      const allowed = !hasInvalidPattern && policy.allow_bash;

      return {
        allowed,
        requires_approval: !hasInvalidPattern && requiresApproval,
        reason: hasInvalidPattern
          ? "Bash policy contains an invalid safe-command pattern and must be corrected before execution."
          : !policy.allow_bash
            ? "Bash access is disabled by repo policy."
            : requiresApproval
              ? "Bash action is allowed but requires approval under the repo policy."
              : safeMatch
                ? "Bash action matches a safe command policy and may run automatically."
                : "Bash action is permitted within the repo policy.",
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
