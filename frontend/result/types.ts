export type ReviewStatus =
  | "awaiting_publisher"
  | "accepted"
  | "changes_requested"
  | "declined";
export type PaymentStatus =
  | "awaiting_confirmation"
  | "paid"
  | "pending"
  | "not_payable"
  | "not_required";
export interface Question {
  id: string;
  text: string;
  options: { id: string; label: string }[];
}
export interface Task {
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
  id: string;
  name: string;
  initials: string;
  color: string;
  submittedAt: string;
  status: ReviewStatus;
  payment: PaymentStatus;
  summary: string;
  answers: { questionId: string; optionId: string; reason: string }[];
  evidence: { name: string; url: string; type: "image" | "video" }[];
  ai: { status: "ready" | "generating" | "failed"; note: string };
  reviewReason?: string;
}
export interface Results {
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
