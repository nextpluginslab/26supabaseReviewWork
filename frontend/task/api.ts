import * as mock from "./mock-api";
import { isDemo, session, sessionEmail } from "@/lib/supabase";
import { request, mutate } from "@/lib/api-client";
import {
  mapTask,
  mapSubmission,
  feedbackBody,
  type PublicTask,
  type RemoteSubmission,
} from "@/lib/contracts";
import type { Feedback, Submission, Evidence } from "./types";
const taskIds = new Map<string, string>();
export async function getTask(id: string) {
  if (isDemo(id)) return mock.getTask(id);
  const { task } = await request<{ task: PublicTask }>(
    "api",
    `/public/tasks/${id}`,
    { public: true },
  );
  taskIds.set(id, task.id);
  return mapTask(task);
}
async function realId(id: string) {
  return taskIds.get(id) || (await getTask(id)).id;
}
export async function getSubmission(id: string): Promise<Submission | null> {
  if (isDemo(id)) return mock.getSubmission(id);
  const auth = await session();
  if (!auth) return null;
  const list = await request<{ items: RemoteSubmission[] }>(
    "submissions",
    `/me/submissions?task_id=${await realId(id)}`,
  );
  if (!list.items.length) return null;
  const row = await request<RemoteSubmission>(
    "submissions",
    `/submissions/${list.items[0].id}`,
  );
  return mapSubmission(row, auth.user.email || "");
}
const draftKey = (id: string) =>
  `reviewwork:feedback:${sessionEmail() || "anonymous"}:${id}`;
export function loadDraft(id: string): Feedback | null {
  if (isDemo(id)) return mock.loadDraft(id);
  const raw = localStorage.getItem(draftKey(id));
  return raw ? JSON.parse(raw) : null;
}
export function saveDraft(id: string, f: Feedback) {
  if (isDemo(id)) return mock.saveDraft(id, f);
  localStorage.setItem(draftKey(id), JSON.stringify(f));
}
export const verifyEmail = mock.verifyEmail;
export const simulateReview = mock.simulateReview;
export async function createUploadUrl(id: string, file: File) {
  if (isDemo(id)) return mock.createUploadUrl(id, file);
  const row = await mutate<{ id: string; path: string; upload_url: string }>(
    "submissions",
    "/uploads",
    {
      task_id: await realId(id),
      name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    },
  );
  return { id: row.id, path: row.path, uploadUrl: row.upload_url };
}
export async function uploadEvidence(
  id: string,
  file: File,
  onProgress: (n: number) => void,
): Promise<Evidence> {
  if (isDemo(id)) return mock.uploadEvidence(id, file, onProgress);
  const target = await createUploadUrl(id, file);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target.uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error("Upload failed. Please retry."));
    xhr.onerror = () => reject(new Error("Upload interrupted. Please retry."));
    xhr.timeout = 120000;
    xhr.ontimeout = () => reject(new Error("Upload timed out."));
    xhr.send(file);
  });
  onProgress(100);
  return {
    id: target.id,
    path: `remote:${target.id}`,
    name: file.name,
    size: file.size,
    type: file.type,
  };
}
export async function getEvidence(path: string) {
  if (!path.startsWith("remote:")) return mock.getEvidence(path);
  const row = await request<{ url: string }>(
    "submissions",
    `/evidence/${path.slice(7)}/read-url`,
    { method: "POST" },
  );
  const response = await fetch(row.url);
  if (!response.ok)
    throw new Error("Evidence unavailable. Refresh and try again.");
  return response.blob();
}
export async function submitFeedback(
  id: string,
  feedback: Feedback,
  expected?: number,
  snapshot?: Submission,
): Promise<Submission> {
  if (isDemo(id)) return mock.submitFeedback(id, feedback, expected);
  const body = feedbackBody(feedback);
  let row: RemoteSubmission;
  if (snapshot) {
    row = await mutate(
      "submissions",
      `/submissions/${snapshot.backendId}/revisions`,
      {
        ...body,
        expected_revision_id: snapshot.currentRevisionId,
        expected_version: snapshot.version,
      },
    );
  } else {
    row = await mutate(
      "submissions",
      `/tasks/${await realId(id)}/submissions`,
      body,
    );
  }
  localStorage.removeItem(draftKey(id));
  const detail = await request<RemoteSubmission>(
    "submissions",
    `/submissions/${row.id}`,
  );
  return mapSubmission(detail, (await session())?.user.email || "");
}
