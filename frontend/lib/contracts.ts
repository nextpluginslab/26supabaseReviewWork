import type { Task, Feedback, Submission, Evidence } from "@/task/types";
export type Config = {
  title: string;
  app_name: string;
  app_type: "web" | "ios" | "android";
  app_url: string;
  experience_instructions: string;
  task_description: string;
  evidence_instructions: string;
  evidence_types: ("image" | "video")[];
  reward_amount_minor: number;
  budget_amount_minor?: number;
  currency: string;
  display_timezone: string;
  deadline_at?: string;
  questions: {
    question_key: string;
    prompt: string;
    options: { option_key: string; label: string }[];
  }[];
};
export type TaskRow = {
  id: string;
  public_slug: string;
  status: string;
  version: number;
  deadline_at: string;
  config: Config;
  published_config: Config | null;
};
export type PublicTask = Config & {
  id: string;
  slug: string;
  status: string;
  deadline_at: string;
  accepting_submissions: boolean;
};
export type Answer = {
  question_key: string;
  selected_option_key: string;
  reason: string;
};
export type Summary = {
  summary: string;
  findings: { text?: string; finding?: string; sources?: string[] }[];
  evidence_observations: unknown[];
  suggested_followups: string[];
  limitations: string[];
};
export type Revision = {
  id: string;
  revision_no: number;
  operation_notes: string;
  answers: Answer[];
  evidence_ids: string[];
  submitted_at: string;
  ai?: { status: string; summary?: Summary };
};
export type RemoteSubmission = {
  id: string;
  submission_no: string;
  task_id: string;
  tester_id: string;
  processing_status: Submission["status"];
  payment_status: Submission["payment"];
  current_revision_id: string;
  version: number;
  first_submitted_at: string;
  current_revision?: Revision;
  revisions?: Revision[];
  decisions?: { action: string; reason: string; created_at: string }[];
  evidence?: {
    id: string;
    name: string;
    mime_type: string;
    size_bytes: number;
    url: string;
  }[];
  ai?: { status: string; summary?: Summary };
  reward?: { id: string; state: string };
};
export function mapTask(row: PublicTask): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.task_description,
    appName: row.app_name,
    appUrl: row.app_url,
    appType: row.app_type,
    publisher: row.app_name,
    minutes: 0,
    instructions: row.experience_instructions,
    steps: row.task_description.split("\n").filter(Boolean),
    evidenceInstructions: row.evidence_instructions,
    evidenceTypes: row.evidence_types,
    reward: row.reward_amount_minor,
    deadline: row.deadline_at,
    timezone: row.display_timezone,
    acceptingSubmissions: row.accepting_submissions,
    questions: row.questions.map((q) => ({
      id: q.question_key,
      title: q.prompt,
      options: q.options.map((o) => ({ id: o.option_key, label: o.label })),
    })),
  };
}
export function feedbackBody(f: Feedback) {
  return {
    operation_notes: f.notes,
    answers: Object.entries(f.answers).map(([question_key, a]) => ({
      question_key,
      selected_option_key: a.optionId,
      reason: a.reason,
    })),
    evidence_ids: f.evidence.map((e) => e.id),
  };
}
export function mapSubmission(
  row: RemoteSubmission,
  email: string,
): Submission {
  const evidence: Evidence[] = (row.evidence || []).map((e) => ({
    id: e.id,
    name: e.name,
    type: e.mime_type,
    size: e.size_bytes,
    path: `remote:${e.id}`,
  }));
  return {
    id: row.submission_no,
    backendId: row.id,
    version: row.version,
    currentRevisionId: row.current_revision_id,
    taskId: row.task_id,
    status: row.processing_status,
    payment: row.payment_status,
    message: row.decisions?.at(-1)?.reason || "",
    revisions: (row.revisions || []).map((r) => ({
      number: r.revision_no,
      submittedAt: r.submitted_at,
      feedback: {
        email,
        notes: r.operation_notes,
        answers: Object.fromEntries(
          r.answers.map((a) => [
            a.question_key,
            { optionId: a.selected_option_key, reason: a.reason },
          ]),
        ),
        evidence: evidence.filter((e) => r.evidence_ids.includes(e.id)),
      },
    })),
  };
}
