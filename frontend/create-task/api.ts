import { cents, validateDraft, type Draft } from "./model";
import { mutate, request } from "@/lib/api-client";
import { session } from "@/lib/supabase";
import type { TaskRow } from "@/lib/contracts";
export async function createTask(
  draft: Draft,
  edit?: { id: string; version: number },
) {
  if (Object.keys(validateDraft(draft)).length)
    throw new Error("Review the required fields before publishing.");
  const auth = await session();
  if (!auth) throw new Error("Sign in before publishing.");
  const config = {
    title: draft.title.trim() || draft.appName.trim(),
    app_name: draft.appName.trim(),
    app_url: draft.appUrl.trim(),
    app_type:
      new URL(draft.appUrl).hostname === "apps.apple.com"
        ? "ios"
        : new URL(draft.appUrl).hostname === "play.google.com"
          ? "android"
          : "web",
    experience_instructions: draft.instructions.trim(),
    task_description: draft.steps.trim(),
    evidence_instructions: draft.evidenceInstructions.trim(),
    evidence_types: draft.evidenceTypes,
    reward_amount_minor: cents(draft.reward)!,
    budget_amount_minor: cents(draft.budget)!,
    currency: "USD",
    deadline_at: new Date(draft.deadline).toISOString(),
    display_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    questions: draft.questions.map((q) => ({
      question_key: q.id,
      prompt: q.title.trim(),
      type: "single_choice",
      reason_required: true,
      options: q.options.map((o) => ({
        option_key: o.id,
        label: o.label.trim(),
      })),
    })),
  };
  const fingerprint = JSON.stringify(config),
    key = `reviewwork:publishing:${auth.user.id}`;
  const saved = JSON.parse(sessionStorage.getItem(key) || "null") as {
    fingerprint: string;
    id: string;
  } | null;
  let task: TaskRow;
  if (saved?.fingerprint === fingerprint && (!edit || saved.id === edit.id)) {
    task = (await request<{ task: TaskRow }>("api", `/tasks/${saved.id}`)).task;
  } else if (edit) {
    task = (
      await mutate<{ task: TaskRow }>(
        "api",
        `/tasks/${edit.id}`,
        { version: edit.version, config },
        "PATCH",
      )
    ).task;
    sessionStorage.setItem(key, JSON.stringify({ fingerprint, id: task.id }));
  } else {
    task = (await mutate<{ task: TaskRow }>("api", "/tasks", { config })).task;
    sessionStorage.setItem(key, JSON.stringify({ fingerprint, id: task.id }));
  }
  if (task.status === "draft" && config.reward_amount_minor > 0) {
    location.assign(`/tasks/${task.id}/results`);
    return {
      task: { id: task.id, title: config.title },
      testUrl: "",
      resultsUrl: `${location.origin}/tasks/${task.id}/results`,
      needsFunding: true,
    };
  }
  if (task.status === "draft")
    task = (
      await mutate<{ task: TaskRow }>("api", `/tasks/${task.id}/publish`, {
        version: task.version,
      })
    ).task;
  sessionStorage.removeItem(key);
  return {
    task: { id: task.id, title: config.title },
    testUrl: `${location.origin}/tasks/${task.public_slug}`,
    resultsUrl: `${location.origin}/tasks/${task.id}/results`,
    needsFunding: false,
  };
}
