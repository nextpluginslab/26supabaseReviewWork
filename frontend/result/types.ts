export type ReviewStatus =
  | "awaiting_publisher"
  | "accepted"
  | "changes_requested"
  | "declined";
export type PaymentStatus =
  | "awaiting_confirmation"
  | "paid"
  | "failed"
  | "processing"
  | "unknown"
  | "reconciliation_required"
  | "pending"
  | "not_payable"
  | "not_required";
export interface Question {
  id: string;
  text: string;
  options: { id: string; label: string }[];
}
export interface Task {
  publicSlug?: string;
  status?: string;
  version?: number;
  id: string;
  title: string;
  product: string;
  description: string;
  reward: number;
  budget: number;
  deadline: string;
  questions: Question[];
}
export interface Submission {
  backendId?: string;
  currentRevisionId?: string;
  version?: number;
  rewardId?: string;
  history?: import("@/lib/contracts").Revision[];
  id: string;
  name: string;
  initials: string;
  color: string;
  submittedAt: string;
  status: ReviewStatus;
  payment: PaymentStatus;
  summary: string;
  answers: { questionId: string; optionId: string; reason: string }[];
  evidence: {
    id?: string;
    name: string;
    url: string;
    type: "image" | "video";
  }[];
  ai: {
    status: "ready" | "generating" | "failed";
    note: string;
    confidenceScore?: number | null;
    confidenceReason?: string;
    observations?: string[];
    followups?: string[];
    limitations?: string[];
  };
  reviewReason?: string;
}
export interface Results {
  budgetSnapshot?: Budget;
  statistics?: {
    total_submissions: number;
    status_counts: Record<string, number>;
    questions: {
      question_key: string;
      options: { option_key: string; label: string; count: number }[];
    }[];
  };
  task: Task;
  submissions: Submission[];
  summary: { title: string; text: string; sources: string[] }[];
  asOf: string;
}
export interface Budget {
  paid: number;
  pending: number;
  remaining: number;
}
