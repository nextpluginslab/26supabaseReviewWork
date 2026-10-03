export class ApiError extends Error {
  constructor(public status: number, public code: string, message = code) {
    super(message);
  }
}
export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
];
export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) throw new ApiError(422, "invalid_uuid");
  return value.toLowerCase();
}
function text(value: unknown, max: number, required = false): string {
  if (
    typeof value !== "string" || value.length > max ||
    (required && !value.trim())
  ) throw new ApiError(422, "invalid_text");
  return value;
}
export function validateBody(
  action: string,
  input: unknown,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(422, "invalid_body");
  }
  const b = input as Record<string, unknown>;
  const allowed = action === "upload"
    ? ["task_id", "name", "mime_type", "size_bytes"]
    : action === "decide"
    ? [
      "action",
      "reason",
      "expected_revision_id",
      "expected_version",
      "confirm_payment",
    ]
    : [
      "answers",
      "operation_notes",
      "evidence_ids",
      ...(action === "revise"
        ? ["expected_revision_id", "expected_version"]
        : []),
    ];
  if (Object.keys(b).some((k) => !allowed.includes(k))) {
    throw new ApiError(422, "unknown_field");
  }
  if (action === "upload") {
    uuid(b.task_id);
    text(b.name, 255, true);
    if (
      !MIME_TYPES.includes(b.mime_type as string) ||
      !Number.isSafeInteger(b.size_bytes) || (b.size_bytes as number) < 1 ||
      (b.size_bytes as number) > MAX_FILE_SIZE
    ) throw new ApiError(422, "invalid_file");
  } else if (action === "decide") {
    if (
      !["accept", "request_changes", "decline"].includes(b.action as string)
    ) throw new ApiError(422, "invalid_action");
    text(b.reason ?? "", 10000, b.action !== "accept");
    if (
      b.confirm_payment !== undefined && typeof b.confirm_payment !== "boolean"
    ) throw new ApiError(422, "invalid_payment_confirmation");
  } else {
    text(b.operation_notes ?? "", 10000);
    if (
      !Array.isArray(b.answers) ||
      b.answers.length > 100
    ) throw new ApiError(422, "invalid_answers");
    const keys = new Set();
    for (const answer of b.answers) {
      if (
        !answer || typeof answer !== "object" || Array.isArray(answer) ||
        Object.keys(answer).some((k) =>
          !["question_key", "selected_option_key", "reason"].includes(k)
        )
      ) throw new ApiError(422, "invalid_answers");
      text(answer.question_key, 128, true);
      text(answer.selected_option_key, 128, true);
      text(answer.reason, 10000, true);
      if (keys.has(answer.question_key)) {
        throw new ApiError(422, "invalid_answers");
      }
      keys.add(answer.question_key);
    }
    if (
      !Array.isArray(b.evidence_ids) || b.evidence_ids.length < 1 ||
      b.evidence_ids.length > 10
    ) throw new ApiError(422, "invalid_evidence");
    const ids = b.evidence_ids.map(uuid);
    if (new Set(ids).size !== ids.length) {
      throw new ApiError(422, "invalid_evidence");
    }
  }
  if (action === "revise" || action === "decide") {
    uuid(b.expected_revision_id);
    if (
      !Number.isSafeInteger(b.expected_version) ||
      (b.expected_version as number) < 1
    ) throw new ApiError(422, "invalid_version");
  }
  return b;
}
export function matchesSignature(bytes: Uint8Array, mime: string): boolean {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  if (mime === "image/png") {
    return bytes.length >= 24 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
      ascii(12, 16) === "IHDR";
  }
  if (mime === "image/jpeg") {
    return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 &&
      bytes[2] === 255;
  }
  if (mime === "image/webp") {
    return bytes.length >= 16 && ascii(0, 4) === "RIFF" &&
      ascii(8, 12) === "WEBP";
  }
  if (mime === "video/webm") {
    return bytes.length >= 16 &&
      [26, 69, 223, 163].every((v, i) => bytes[i] === v);
  }
  if (mime === "video/mp4" || mime === "video/quicktime") {
    return bytes.length >= 16 && ascii(4, 8) === "ftyp" &&
      (mime !== "video/quicktime" || ascii(8, 12) === "qt  ");
  }
  return false;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b)
    ).map(([k, v]) =>
      JSON.stringify(k) + ":" + canonical(v)
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}
export const errorStatus: Record<string, number> = {
  "Human payment confirmation required": 422,
  "Task has not been funded": 409,
  "Insufficient task budget": 409,
  "Reward authorization conflict": 409,
  task_not_found: 404,
  submission_not_found: 404,
  forbidden: 403,
  email_not_verified: 403,
  task_closed: 409,
  already_submitted: 409,
  version_conflict: 409,
  invalid_state: 409,
  idempotency_conflict: 409,
  payment_not_configured: 409,
  rate_limited: 429,
  upload_quota_exceeded: 429,
  invalid_answers: 422,
  invalid_evidence: 422,
  reason_required: 422,
  invalid_request: 422,
};
