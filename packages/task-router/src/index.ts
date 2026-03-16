import type { RoutingTier, TaskGoalType } from "shared";

export interface TaskRoutingInput {
  title?: string;
  prompt: string;
  goal_type?: TaskGoalType;
  expected_file_count?: number;
}

export interface RoutingDecision {
  tier: RoutingTier;
  reason: string;
  requires_classifier: boolean;
}

const cheapGoalTypes = new Set<TaskGoalType>(["question"]);
const strongGoalTypes = new Set<TaskGoalType>(["plan", "implement", "fix", "refactor", "debug"]);
const cheapKeywords = ["explain", "summarize", "read-only", "what does", "show me"];
const strongKeywords = [
  "plan",
  "implement",
  "fix",
  "refactor",
  "debug",
  "test",
  "build",
  "migration",
  "migrate",
];

export function decideTaskRoute(input: TaskRoutingInput): RoutingDecision {
  const haystack = `${input.title ?? ""} ${input.prompt}`.toLowerCase();

  if (input.goal_type && cheapGoalTypes.has(input.goal_type)) {
    return {
      tier: "cheap",
      reason: "Read-only question intent stays on the cheap tier.",
      requires_classifier: false,
    };
  }

  if (input.goal_type && strongGoalTypes.has(input.goal_type)) {
    return {
      tier: "strong",
      reason: `Goal type '${input.goal_type}' is a strong-tier workflow.`,
      requires_classifier: false,
    };
  }

  if (input.expected_file_count && input.expected_file_count > 3) {
    return {
      tier: "strong",
      reason: "Expected file count suggests a multi-file change.",
      requires_classifier: false,
    };
  }

  if (strongKeywords.some((keyword) => haystack.includes(keyword))) {
    return {
      tier: "strong",
      reason: "Prompt mentions tests, builds, migrations, or implementation work.",
      requires_classifier: false,
    };
  }

  if (cheapKeywords.some((keyword) => haystack.includes(keyword))) {
    return {
      tier: "cheap",
      reason: "Prompt reads like repo analysis or explanation work.",
      requires_classifier: false,
    };
  }

  return {
    tier: "cheap",
    reason:
      "Prompt is ambiguous, so a cheap classifier should run before escalating if confidence is low.",
    requires_classifier: true,
  };
}
