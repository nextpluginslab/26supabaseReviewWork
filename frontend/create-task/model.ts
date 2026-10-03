import type { Question, Task } from "../task/types";
export type Draft = {
  title: string;
  appName: string;
  appUrl: string;
  instructions: string;
  steps: string;
  evidenceInstructions: string;
  evidenceTypes: Task["evidenceTypes"];
  reward: string;
  budget: string;
  minutes: string;
  deadline: string;
  questions: Question[];
};
export function defaultDeadline(now = new Date()): string {
  const deadline = new Date(now);
  deadline.setDate(deadline.getDate() + 3);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${deadline.getFullYear()}-${pad(deadline.getMonth() + 1)}-${pad(deadline.getDate())}T${pad(deadline.getHours())}:${pad(deadline.getMinutes())}`;
}
export const blankDraft = (): Draft => ({
  title: "",
  appName: "",
  appUrl: "",
  instructions: "",
  steps: "",
  evidenceInstructions: "",
  evidenceTypes: ["image", "video"],
  reward: "0",
  budget: "0",
  minutes: "",
  deadline: defaultDeadline(),
  questions: [],
});
export function cents(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}
export function validateDraft(
  d: Draft,
  now = Date.now(),
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!d.appName.trim()) errors.appName = "This field is required.";
  try {
    const url = new URL(d.appUrl);
    if (url.protocol !== "https:" || url.username || url.password)
      throw Error();
  } catch {
    errors.appUrl = "Enter a valid HTTPS product or App Store URL.";
  }
  if (
    d.minutes.trim() &&
    (!Number.isInteger(Number(d.minutes)) ||
      Number(d.minutes) < 1 ||
      Number(d.minutes) > 480)
  )
    errors.minutes = "Enter 1–480 minutes.";
  if (!d.evidenceTypes.length)
    errors.evidenceTypes = "Select at least one evidence type.";
  const reward = cents(d.reward),
    budget = cents(d.budget);
  if (reward === null || reward > 99999999)
    errors.reward = "Enter a non-negative USD amount with up to two decimals.";
  if (budget === null || budget > 99999999)
    errors.budget = "Enter a non-negative USD amount with up to two decimals.";
  else if (reward !== null && budget !== null && budget < reward)
    errors.budget = "Budget must cover at least one reward.";
  if (reward !== null && reward > 0 && budget !== null && budget < 50)
    errors.budget =
      "Stripe Sandbox funding requires at least $0.50 total budget.";
  if (
    !Number.isFinite(new Date(d.deadline).getTime()) ||
    new Date(d.deadline).getTime() <= now
  )
    errors.deadline = "Choose a future deadline.";
  for (const q of d.questions) {
    if (!q.title.trim()) errors[q.id] = "Enter a question.";
    else if (q.options.length < 2 || q.options.some((o) => !o.label.trim()))
      errors[q.id] = "Add at least two non-empty options.";
    else if (
      new Set(q.options.map((o) => o.label.trim().toLowerCase())).size !==
      q.options.length
    )
      errors[q.id] = "Options must be unique.";
  }
  return errors;
}
