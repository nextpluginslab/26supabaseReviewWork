import { cents, validateDraft, type Draft } from "./model";
import type { CreatedTask } from "../lib/created-tasks";
// Mock POST /api/tasks. Replace with authenticated fetch and Stripe Sandbox funding.
export async function createTask(draft: Draft) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!navigator.onLine)
    throw new Error("You’re offline. Reconnect and publish again.");
  if (Object.keys(validateDraft(draft)).length)
    throw new Error("Review the required fields before publishing.");
  const id = `rw-${crypto.randomUUID()}`;
  const task: CreatedTask = {
    id,
    title: draft.title.trim() || draft.appName.trim(),
    appName: draft.appName.trim(),
    appUrl: draft.appUrl.trim(),
    appType:
      new URL(draft.appUrl).hostname === "apps.apple.com"
        ? "ios"
        : new URL(draft.appUrl).hostname === "play.google.com"
          ? "android"
          : "web",
    publisher: `${draft.appName.trim()} team`,
    description: "",
    instructions: draft.instructions.trim(),
    steps: draft.steps
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    evidenceInstructions: draft.evidenceInstructions.trim(),
    evidenceTypes: [...draft.evidenceTypes],
    reward: cents(draft.reward)!,
    budget: cents(draft.budget)!,
    minutes: Number(draft.minutes),
    deadline: new Date(draft.deadline).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    questions: draft.questions.map((q) => ({
      ...q,
      title: q.title.trim(),
      options: q.options.map((o) => ({ ...o, label: o.label.trim() })),
    })),
  };
  localStorage.setItem(`reviewwork:created-task:${id}`, JSON.stringify(task));
  return {
    task,
    testUrl: `${location.origin}/tasks/${id}`,
    resultsUrl: `${location.origin}/tasks/${id}/results`,
  };
}
