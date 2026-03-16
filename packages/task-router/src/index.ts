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

export interface ClassifierDecision {
  category: "analysis" | "change" | "planning";
  score: number;
  confidence: number;
  recommended_tier: RoutingTier;
  reason: string;
}

export interface ResolvedRoutingDecision extends RoutingDecision {
  classifier_score: number | null;
  classifier_confidence: number | null;
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

export function classifyAmbiguousTask(input: TaskRoutingInput): ClassifierDecision {
  const haystack = `${input.title ?? ""} ${input.prompt}`.toLowerCase();
  const actionHints = [
    "add",
    "change",
    "create",
    "save",
    "wire",
    "update",
    "persist",
    "endpoint",
    "form",
    "page",
  ];
  const analysisHints = ["read", "review", "summarize", "inventory", "document", "describe"];
  const planningHints = ["where to start", "next step", "approach", "strategy", "should we"];

  if (actionHints.some((hint) => haystack.includes(hint))) {
    return {
      category: "change",
      score: 0.84,
      confidence: 0.82,
      recommended_tier: "strong",
      reason: "Classifier sees likely product or code changes.",
    };
  }

  if (analysisHints.some((hint) => haystack.includes(hint))) {
    return {
      category: "analysis",
      score: 0.18,
      confidence: 0.79,
      recommended_tier: "cheap",
      reason: "Classifier sees repo analysis or explanation work.",
    };
  }

  if (planningHints.some((hint) => haystack.includes(hint))) {
    return {
      category: "planning",
      score: 0.61,
      confidence: 0.58,
      recommended_tier: "strong",
      reason: "Classifier sees planning work but with limited confidence.",
    };
  }

  if ((input.expected_file_count ?? 0) > 1) {
    return {
      category: "change",
      score: 0.72,
      confidence: 0.68,
      recommended_tier: "strong",
      reason: "Classifier expects the task to span more than one file.",
    };
  }

  return {
    category: "analysis",
    score: 0.42,
    confidence: 0.46,
    recommended_tier: "cheap",
    reason: "Classifier could not confidently separate analysis from change work.",
  };
}

export function resolveTaskRoute(input: TaskRoutingInput): ResolvedRoutingDecision {
  const decision = decideTaskRoute(input);

  if (!decision.requires_classifier) {
    return {
      ...decision,
      classifier_score: null,
      classifier_confidence: null,
    };
  }

  const classifier = classifyAmbiguousTask(input);

  if (classifier.confidence < 0.65) {
    return {
      tier: "strong",
      reason: `Cheap classifier confidence was ${(classifier.confidence * 100).toFixed(0)}%, so the task escalated to the strong tier.`,
      requires_classifier: true,
      classifier_score: classifier.score,
      classifier_confidence: classifier.confidence,
    };
  }

  return {
    tier: classifier.recommended_tier,
    reason: `${classifier.reason} Confidence ${(classifier.confidence * 100).toFixed(0)}% kept the task on the ${classifier.recommended_tier} tier.`,
    requires_classifier: true,
    classifier_score: classifier.score,
    classifier_confidence: classifier.confidence,
  };
}
