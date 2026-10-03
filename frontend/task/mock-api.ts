import { readCreatedTask } from "../lib/created-tasks";
import { taskFixture } from "./fixtures";
import { validateFeedback, validateFile } from "./validation";
import type {
  Evidence,
  Feedback,
  PaymentStatus,
  ReviewStatus,
  Submission,
} from "./types";

// Browser-only mock adapter. Replace these functions with fetch calls to the
// documented endpoints; do not ship local verification/storage as authentication.
const prefix = "fieldwork:v1:";
const wait = (ms = 350) =>
  new Promise<void>((resolve, reject) =>
    setTimeout(
      () =>
        navigator.onLine
          ? resolve()
          : reject(new Error("You’re offline. Reconnect and try again.")),
      ms,
    ),
  );
function read<T>(key: string): T | null {
  const raw = localStorage.getItem(prefix + key);
  return raw ? (JSON.parse(raw) as T) : null;
}
function save(key: string, value: unknown) {
  localStorage.setItem(prefix + key, JSON.stringify(value));
}
export async function getTask(id: string) {
  await wait();
  if (id === "missing")
    throw new Error("We couldn’t find this task. Check your task link.");
  return readCreatedTask(id) ?? taskFixture(id);
}
export async function getSubmission(
  taskId: string,
): Promise<Submission | null> {
  await wait(120);
  return read<Submission>(`submission:${taskId}`);
}
export function loadDraft(taskId: string) {
  return read<Feedback>(`draft:${taskId}`);
}
export function saveDraft(taskId: string, draft: Feedback) {
  save(`draft:${taskId}`, draft);
}
export async function verifyEmail(email: string, code: string) {
  await wait();
  if (code !== "123456")
    throw new Error(
      "Use the demo code 123456. No email is sent in this preview.",
    );
  sessionStorage.setItem(prefix + "verifiedEmail", email.trim().toLowerCase());
}
export async function createUploadUrl(taskId: string, file: File) {
  await wait(180);
  const error = validateFile(
    file,
    readCreatedTask(taskId) ?? taskFixture(taskId),
  );
  if (error) throw new Error(error);
  const id = crypto.randomUUID();
  return {
    id,
    uploadUrl: `mock://uploads/${id}`,
    path: `${taskId}/${id}/${file.name}`,
  };
}
function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("fieldwork-evidence", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("Local evidence storage is unavailable."));
  });
}
export async function uploadEvidence(
  taskId: string,
  file: File,
  onProgress: (n: number) => void,
): Promise<Evidence> {
  const target = await createUploadUrl(taskId, file);
  for (const n of [20, 55, 85]) {
    await wait(180);
    onProgress(n);
  }
  const database = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("files", "readwrite");
      tx.objectStore("files").put(file, target.path);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(new Error("Couldn’t save this file. Try again."));
      tx.onabort = () => reject(new Error("Upload interrupted. Try again."));
    });
  } finally {
    database.close();
  }
  onProgress(100);
  return {
    id: target.id,
    name: file.name,
    size: file.size,
    type: file.type,
    path: target.path,
  };
}
export async function getEvidence(path: string): Promise<Blob | undefined> {
  const database = await db();
  try {
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const request = database
        .transaction("files")
        .objectStore("files")
        .get(path);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Couldn’t open this evidence."));
    });
  } finally {
    database.close();
  }
}
export async function submitFeedback(
  taskId: string,
  feedback: Feedback,
  expectedRevision?: number,
): Promise<Submission> {
  await wait(650);
  const current = read<Submission>(`submission:${taskId}`);
  if (
    current &&
    (current.status !== "changes_requested" ||
      expectedRevision !== current.revisions.length)
  )
    throw new Error(
      "This submission has changed. Refresh its status before continuing.",
    );
  if (!current && expectedRevision !== undefined)
    throw new Error("Submission not found. Reload the page.");
  if (
    sessionStorage.getItem(prefix + "verifiedEmail") !==
    feedback.email.trim().toLowerCase()
  )
    throw new Error("Verify your email before submitting.");
  if (
    current &&
    current.revisions[0].feedback.email.toLowerCase() !==
      feedback.email.trim().toLowerCase()
  )
    throw new Error("Use the email associated with your original submission.");
  const errors = validateFeedback(
    readCreatedTask(taskId) ?? taskFixture(taskId),
    feedback,
    Boolean(current),
  );
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  for (const file of feedback.evidence) {
    if (!file.path.startsWith(`${taskId}/`) || !(await getEvidence(file.path)))
      throw new Error("An evidence file is missing. Please upload it again.");
  }
  // Recheck after async evidence reads to prevent competing local revisions.
  const latest = read<Submission>(`submission:${taskId}`);
  if (
    latest?.revisions.length !== current?.revisions.length ||
    latest?.status !== current?.status
  )
    throw new Error("Submission updated in another tab. Refresh its status.");
  const submission: Submission = {
    id: current?.id ?? `FW-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    taskId,
    status: "awaiting_publisher",
    payment: "awaiting_confirmation",
    message: "",
    revisions: [
      ...(current?.revisions ?? []),
      {
        number: (current?.revisions.length ?? 0) + 1,
        submittedAt: new Date().toISOString(),
        feedback: structuredClone(feedback),
      },
    ],
  };
  save(`submission:${taskId}`, submission);
  localStorage.removeItem(prefix + `draft:${taskId}`);
  return submission;
}
// Explicit preview controls, never an automatic AI decision or payment.
export async function simulateReview(
  taskId: string,
  status: ReviewStatus,
  payment: PaymentStatus = "awaiting_confirmation",
) {
  await wait();
  const current = read<Submission>(`submission:${taskId}`);
  if (!current) throw new Error("Submit feedback first.");
  current.status = status;
  current.payment = payment;
  current.message =
    status === "changes_requested"
      ? "Thanks for your feedback! Please add a screenshot showing the timer after you started your session, or show the screen where you got stuck. Keep your existing answers or add more detail."
      : status === "declined"
        ? "The evidence does not show the product specified in this task. The publisher could not confirm this experience."
        : "";
  save(`submission:${taskId}`, current);
  return current;
}
