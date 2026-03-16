import type { TaskRecord } from "shared";

export interface PullRequestDraftInput {
  task: Pick<TaskRecord, "title" | "routing_reason" | "branch_name">;
  base_branch: string;
  artifact_summaries: readonly string[];
}

export interface PullRequestDraft {
  title: string;
  body: string;
  head_branch: string;
  base_branch: string;
}

export function buildPullRequestDraft(input: PullRequestDraftInput): PullRequestDraft {
  const summaryLines = input.artifact_summaries.map((summary) => `- ${summary}`).join("\n");

  return {
    title: input.task.title,
    head_branch: input.task.branch_name ?? "task/branch-pending",
    base_branch: input.base_branch,
    body: `## Summary\n${summaryLines || "- Task artifact summary pending"}\n\n## Routing\n${input.task.routing_reason ?? "Routing reason pending"}`,
  };
}
