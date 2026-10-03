import type { Task } from "../task/types";
export type CreatedTask = Task & { budget: number };
export function readCreatedTask(id: string): CreatedTask | null {
  const raw = localStorage.getItem(`reviewwork:created-task:${id}`);
  if (raw) return JSON.parse(raw) as CreatedTask;
  if (id.startsWith("rw-"))
    throw new Error(
      "This demo task is stored in the browser where it was created. Open it there, or connect a backend to share it.",
    );
  return null;
}
