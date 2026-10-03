import * as mock from "./mock-api";
import { isDemo, sessionEmail, supabase } from "@/lib/supabase";
import { request, mutate } from "@/lib/api-client";
import type { TaskRow, RemoteSubmission, Summary } from "@/lib/contracts";
import type { Results, Submission } from "./types";
export { money, approveInResults } from "./mock-api";
export function getDistribution(r: Results, id: string) {
  const question = r.statistics?.questions.find((q) => q.question_key === id);
  return question
    ? question.options.map((o) => ({
        id: o.option_key,
        label: o.label,
        count: o.count,
      }))
    : mock.getDistribution(r, id);
}
export function getBudget(r: Results) {
  return r.budgetSnapshot || mock.getBudget(r);
}
export function getSession() {
  return sessionEmail() || mock.getSession();
}
export const signIn = mock.signIn;
export async function signOut() {
  if (sessionEmail()) await supabase().auth.signOut();
  else mock.signOut();
}
export function mapRow(r: RemoteSubmission): Submission {
  const rev = r.revisions?.at(-1) || r.current_revision;
  const ai = rev?.ai || r.ai;
  return {
    id: r.submission_no,
    backendId: r.id,
    currentRevisionId: r.current_revision_id,
    version: r.version,
    rewardId: r.reward?.id,
    name: `Tester ${r.submission_no.slice(-6)}`,
    initials: "T",
    color: "#e8ede5",
    submittedAt: r.first_submitted_at,
    status: r.processing_status,
    payment: r.payment_status,
    summary: rev?.operation_notes || "",
    answers: (rev?.answers || []).map((a) => ({
      questionId: a.question_key,
      optionId: a.selected_option_key,
      reason: a.reason,
    })),
    evidence: (r.evidence || [])
      .filter((e) => rev?.evidence_ids?.includes(e.id))
      .map((e) => ({
        id: e.id,
        name: e.name,
        url: e.url,
        type: e.mime_type.startsWith("video/") ? "video" : "image",
      })),
    ai: {
      status:
        ai?.status === "succeeded"
          ? "ready"
          : ai?.status === "failed"
            ? "failed"
            : "generating",
      note: ai?.summary?.summary || "",
      confidenceScore: ai?.summary?.confidence_score,
      confidenceReason: ai?.summary?.confidence_reason,
      observations: ai?.summary?.evidence_observations?.map((f) => f.text) || [],
      followups: ai?.summary?.suggested_followups?.map((f) => f.text) || [],
      limitations: ai?.summary?.limitations || [],
    },
    reviewReason: r.decisions?.at(-1)?.reason,
    history: r.revisions,
  };
}
export async function getTask(id: string) {
  if (isDemo(id)) return mock.getTask(id);
  return (await getResults(id)).task;
}
export async function getResults(id: string): Promise<Results> {
  if (isDemo(id)) return mock.getResults(id);
  const { task } = await request<{ task: TaskRow }>("api", `/tasks/${id}`);
  const config = task.published_config || task.config;
  const items: RemoteSubmission[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: RemoteSubmission[]; next_cursor: string | null } =
      await request<{ items: RemoteSubmission[]; next_cursor: string | null }>(
        "submissions",
        `/tasks/${id}/submissions?limit=100${cursor ? `&cursor=${cursor}` : ""}`,
      );
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  const insights = await request<{
    ai: {
      status: string;
      summary: Summary | null;
      stale: boolean;
      snapshot: {
        submissions: { submission_id: string; revision_id: string }[];
      } | null;
    };
    budget: { paid: number; pending: number; remaining: number };
    statistics: Results["statistics"];
    as_of: string;
  }>("api", `/tasks/${id}/results`);
  const sum = insights.ai?.summary;
  const summaries = sum
    ? [
        {
          title: insights.ai.stale
            ? "AI summary · earlier snapshot (refresh pending)"
            : "AI summary",
          text: sum.summary,
          sources: [],
        },
        ...(sum.findings || []).map((f) => ({
          title: "Finding",
          text: f.text || "",
          sources: (
            (f as unknown as { source_refs: string[] }).source_refs || []
          ).flatMap((ref) => {
            const source = insights.ai.snapshot?.submissions.find((s) =>
              ref.includes(s.revision_id),
            );
            const item = items.find((i) => i.id === source?.submission_id);
            return item ? [item.submission_no] : [];
          }),
        })),
      ]
    : [];
  return {
    task: {
      id,
      title: config.title,
      product: config.app_name,
      description: config.task_description,
      reward: config.reward_amount_minor,
      budget: config.budget_amount_minor || 0,
      deadline: task.deadline_at || config.deadline_at || "",
      questions: config.questions.map((q) => ({
        id: q.question_key,
        text: q.prompt,
        options: q.options.map((o) => ({ id: o.option_key, label: o.label })),
      })),
      publicSlug: task.public_slug,
      status: task.status,
      version: task.version,
    },
    submissions: items.map(mapRow),
    summary: summaries,
    asOf: insights.as_of || new Date().toISOString(),
    statistics: insights.statistics,
    budgetSnapshot: insights.budget,
  };
}
export async function getSubmissionDetail(id: string) {
  return mapRow(
    await request<RemoteSubmission>("submissions", `/submissions/${id}`),
  );
}
export async function decide(
  taskId: string,
  s: Submission,
  action: "accept" | "request_changes" | "decline",
  reason = "",
) {
  await mutate("submissions", `/submissions/${s.backendId}/decisions`, {
    action,
    reason,
    expected_revision_id: s.currentRevisionId,
    expected_version: s.version,
    ...(action === "accept" ? { confirm_payment: true } : {}),
  });
  return getResults(taskId);
}
export async function approveSubmission(
  taskId: string,
  id: string,
  snapshot?: Submission,
) {
  if (isDemo(taskId)) return mock.approveSubmission(taskId, id);
  if (!snapshot) throw new Error("Refresh the submission before confirming.");
  return decide(taskId, snapshot, "accept");
}

export async function refreshEvidence(e: Submission["evidence"][number]) {
  if (!e.id) return e;
  const signed = await request<{ url: string }>(
    "submissions",
    `/evidence/${e.id}/read-url`,
    { method: "POST" },
  );
  return { ...e, url: signed.url };
}
