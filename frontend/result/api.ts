import { createFixture } from "./fixtures";
import type { Budget, Results, Submission } from "./types";
const pause = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms));
export const money = (minor: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
export function getBudget(results: Results): Budget {
  const paid =
    results.submissions.filter(
      (s) => s.status === "accepted" && s.payment === "paid",
    ).length * results.task.reward;
  const pending =
    results.submissions.filter(
      (s) => s.status === "accepted" && s.payment === "pending",
    ).length * results.task.reward;
  return { paid, pending, remaining: results.task.budget - paid - pending };
}
export function getDistribution(results: Results, questionId: string) {
  const question = results.task.questions.find((q) => q.id === questionId);
  return (
    question?.options.map((option) => ({
      ...option,
      count: results.submissions.filter(
        (s) =>
          s.answers.find((a) => a.questionId === questionId)?.optionId ===
          option.id,
      ).length,
    })) ?? []
  );
}
// Pure mock transaction. The real backend must enforce ownership, budgets and idempotency.
export function approveInResults(
  results: Results,
  submissionId: string,
  authenticated: boolean,
): Submission {
  if (!authenticated)
    throw new Error("Sign in as the developer to confirm feedback.");
  const submission = results.submissions.find((s) => s.id === submissionId);
  if (!submission) throw new Error("This submission could not be found.");
  if (submission.status === "accepted") return submission;
  if (submission.status === "declined")
    throw new Error("This submission has already been declined.");
  if (getBudget(results).remaining < results.task.reward)
    throw new Error(
      "There is not enough remaining budget to confirm this submission.",
    );
  submission.status = "accepted";
  submission.payment = results.task.reward === 0 ? "not_required" : "paid";
  submission.reviewReason =
    "Confirmed by the developer after reviewing the answers and evidence.";
  return submission;
}
const key = (id: string) => `fieldwork:mock-results:v1:${id}`;
function read(id: string): Results {
  const raw = localStorage.getItem(key(id));
  return raw ? (JSON.parse(raw) as Results) : createFixture(id);
}
// Replace these adapter bodies with fetch calls to the documented endpoints.
export async function getTask(id: string) {
  await pause();
  return read(id).task;
} // GET /api/tasks/:id
export async function getResults(id: string): Promise<Results> {
  await pause();
  return read(id);
} // GET /api/tasks/:id/results
export function getSession() {
  return sessionStorage.getItem("fieldwork:demo-session");
}
export async function signIn(email: string) {
  await pause();
  sessionStorage.setItem("fieldwork:demo-session", email);
  return email;
}
export function signOut() {
  sessionStorage.removeItem("fieldwork:demo-session");
}
export async function approveSubmission(taskId: string, submissionId: string) {
  // POST /api/submissions/:id/approve
  await pause(700);
  // No await between read/validate/write: repeat calls in this tab cannot spend twice.
  const results = read(taskId);
  approveInResults(results, submissionId, Boolean(getSession()));
  localStorage.setItem(key(taskId), JSON.stringify(results));
  return results;
}
