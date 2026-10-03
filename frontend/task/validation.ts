import type { Feedback, Task } from "./types";
export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const MIME_TYPES = {
  image: ["image/png", "image/jpeg", "image/webp"],
  video: ["video/mp4", "video/webm", "video/quicktime"],
};
export function validateFile(
  file: Pick<File, "type" | "size">,
  task: Task,
): string | null {
  if (!task.evidenceTypes.flatMap((t) => MIME_TYPES[t]).includes(file.type))
    return "Use a supported screenshot or recording format.";
  if (file.size === 0) return "This file is empty. Choose another file.";
  if (file.size > MAX_FILE_SIZE) return "Each file must be 50 MB or smaller.";
  return null;
}
export function validateFeedback(
  task: Task,
  feedback: Feedback,
  resubmission = false,
  now = Date.now(),
) {
  const errors: Record<string, string> = {};
  if (
    !resubmission &&
    (task.acceptingSubmissions === false ||
      now >= new Date(task.deadline).getTime())
  )
    errors.deadline = "This task is closed for new submissions.";
  if (!feedback.evidence.length)
    errors.evidence =
      "Add at least one screenshot or recording, including evidence of any blocker.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(feedback.email.trim()))
    errors.email = "Enter a valid email address.";
  for (const q of task.questions) {
    const answer = feedback.answers[q.id];
    if (!q.options.some((o) => o.id === answer?.optionId))
      errors[q.id] = "Choose one answer.";
    else if (!answer?.reason.trim())
      errors[q.id] = "Tell us why you chose this answer.";
  }
  if (
    Object.keys(feedback.answers).some(
      (id) => !task.questions.some((q) => q.id === id),
    )
  )
    errors.answers = "The questions have changed. Reload this task.";
  return errors;
}
