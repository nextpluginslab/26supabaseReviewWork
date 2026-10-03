export type Question = {
  id: string;
  title: string;
  options: { id: string; label: string }[];
};
export type Task = {
  id: string;
  title: string;
  description: string;
  appName: string;
  appUrl: string;
  appType: "web" | "ios" | "android";
  publisher: string;
  minutes: number;
  instructions: string;
  steps: string[];
  evidenceInstructions: string;
  evidenceTypes: ("image" | "video")[];
  reward: number;
  deadline: string;
  timezone: string;
  questions: Question[];
};
export type Evidence = {
  id: string;
  name: string;
  size: number;
  type: string;
  path: string;
};
export type Answer = { optionId: string; reason: string };
export type Feedback = {
  email: string;
  notes: string;
  answers: Record<string, Answer>;
  evidence: Evidence[];
};
export type ReviewStatus =
  | "awaiting_publisher"
  | "changes_requested"
  | "accepted"
  | "declined";
export type PaymentStatus =
  | "awaiting_confirmation"
  | "pending"
  | "paid"
  | "failed"
  | "not_payable"
  | "not_required";
export type Revision = {
  number: number;
  submittedAt: string;
  feedback: Feedback;
};
export type Submission = {
  id: string;
  taskId: string;
  status: ReviewStatus;
  payment: PaymentStatus;
  message: string;
  revisions: Revision[];
};
