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

export interface CreateGitHubPullRequestInput {
  token: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  head_branch: string;
  base_branch: string;
  draft?: boolean;
  fetch_impl?: typeof fetch;
}

export interface GitHubPullRequest {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  head_sha: string | null;
}

export type GitHubPullRequestCreator = (
  input: CreateGitHubPullRequestInput,
) => Promise<GitHubPullRequest>;

export function buildPullRequestDraft(input: PullRequestDraftInput): PullRequestDraft {
  const summaryLines = input.artifact_summaries.map((summary) => `- ${summary}`).join("\n");

  return {
    title: input.task.title,
    head_branch: input.task.branch_name ?? "task/branch-pending",
    base_branch: input.base_branch,
    body: `## Summary\n${summaryLines || "- Task artifact summary pending"}\n\n## Routing\n${input.task.routing_reason ?? "Routing reason pending"}`,
  };
}

export const createGitHubPullRequest: GitHubPullRequestCreator = async (input) => {
  const fetchImpl = input.fetch_impl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is not available for GitHub pull request creation.");
  }

  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        "user-agent": "make-an-agent-control-plane",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head_branch,
        base: input.base_branch,
        draft: input.draft ?? true,
      }),
    },
  );

  const payload = (await response.json().catch(() => null)) as {
    message?: string;
    number?: number;
    html_url?: string;
    state?: string;
    draft?: boolean;
    head?: { sha?: string };
  } | null;

  if (!response.ok) {
    throw new Error(
      payload?.message ?? `GitHub pull request creation failed with status ${response.status}.`,
    );
  }

  if (typeof payload?.number !== "number" || typeof payload?.html_url !== "string") {
    throw new Error("GitHub pull request creation returned an incomplete response.");
  }

  return {
    number: payload.number,
    url: payload.html_url,
    state: typeof payload.state === "string" ? payload.state : "open",
    draft: Boolean(payload.draft),
    head_sha: typeof payload.head?.sha === "string" ? payload.head.sha : null,
  };
};
