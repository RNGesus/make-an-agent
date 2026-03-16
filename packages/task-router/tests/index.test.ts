import { expect, test } from "vite-plus/test";
import { decideTaskRoute, resolveTaskRoute } from "../src/index.ts";

test("routes read-only questions to the cheap tier", () => {
  const decision = decideTaskRoute({
    prompt: "Explain the current repository policy setup",
    goal_type: "question",
  });

  expect(decision.tier).toBe("cheap");
  expect(decision.requires_classifier).toBe(false);
});

test("routes implementation work to the strong tier", () => {
  const decision = decideTaskRoute({
    prompt: "Implement the repo scan endpoint and cover it with tests",
    goal_type: "implement",
  });

  expect(decision.tier).toBe("strong");
  expect(decision.requires_classifier).toBe(false);
});

test("marks ambiguous prompts for classifier follow-up", () => {
  const decision = decideTaskRoute({
    prompt: "Take a look at the repo and tell me where to start",
  });

  expect(decision.tier).toBe("cheap");
  expect(decision.requires_classifier).toBe(true);
});

test("keeps classifier-backed change work on the strong tier", () => {
  const decision = resolveTaskRoute({
    prompt: "Wire the task form to the API and save routing decisions",
  });

  expect(decision.tier).toBe("strong");
  expect(decision.classifier_score).not.toBeNull();
  expect(decision.classifier_confidence).not.toBeNull();
  expect(decision.reason).toContain("Confidence");
});

test("escalates low-confidence ambiguous work to the strong tier", () => {
  const decision = resolveTaskRoute({
    prompt: "Take a look at the repo and tell me where to start",
  });

  expect(decision.tier).toBe("strong");
  expect(decision.classifier_confidence).toBeLessThan(0.65);
  expect(decision.reason).toContain("escalated");
});
