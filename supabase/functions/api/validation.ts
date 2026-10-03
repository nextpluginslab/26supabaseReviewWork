export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}
export function validateConfig(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(
      422,
      "invalid_config",
      "Task configuration must be an object.",
    );
  }
  const c = input as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const allowed = [
    "title",
    "app_name",
    "app_type",
    "app_url",
    "experience_instructions",
    "task_description",
    "evidence_types",
    "evidence_instructions",
    "questions",
    "reward_amount_minor",
    "budget_amount_minor",
    "currency",
    "duration_seconds",
    "deadline_at",
    "display_timezone",
  ];
  for (const key of Object.keys(c)) {
    if (!allowed.includes(key)) errors[key] = "Unknown or read-only field.";
  }
  for (
    const key of [
      "title",
      "app_name",
      "app_url",
      "experience_instructions",
      "task_description",
      "evidence_instructions",
      "display_timezone",
    ]
  ) {
    if (
      typeof c[key] !== "string" || !(c[key] as string).trim() ||
      (c[key] as string).length >
        (["title", "app_name"].includes(key) ? 200 : 10000)
    ) errors[key] = "Required non-empty text within length limit.";
  }
  if (!["web", "ios", "android"].includes(String(c.app_type))) {
    errors.app_type = "Use web, ios or android.";
  }
  try {
    const url = new URL(String(c.app_url));
    if (url.protocol !== "https:" || url.username || url.password) throw 0;
  } catch {
    errors.app_url = "Use an HTTPS URL without credentials.";
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: String(c.display_timezone) })
      .format();
  } catch {
    errors.display_timezone = "Use a valid IANA timezone.";
  }
  for (const key of ["reward_amount_minor", "budget_amount_minor"]) {
    if (
      !Number.isSafeInteger(c[key]) || Number(c[key]) < 0 ||
      Number(c[key]) > 100000000
    ) errors[key] = "Use integer cents between 0 and 100000000.";
  }
  if (Number(c.reward_amount_minor) > Number(c.budget_amount_minor)) {
    errors.budget_amount_minor = "Budget must cover at least one reward.";
  }
  if (c.currency !== "USD") errors.currency = "Only USD is supported.";
  const types = c.evidence_types;
  if (
    !Array.isArray(types) || !types.length || types.length > 2 ||
    new Set(types).size !== types.length ||
    types.some((t) => !["image", "video"].includes(t))
  ) errors.evidence_types = "Select image and/or video.";
  if ((c.duration_seconds !== undefined) === (c.deadline_at !== undefined)) {
    errors.deadline_at =
      "Provide exactly one of duration_seconds or deadline_at.";
  }
  if (
    c.duration_seconds !== undefined &&
    (!Number.isSafeInteger(c.duration_seconds) ||
      Number(c.duration_seconds) < 60 || Number(c.duration_seconds) > 31536000)
  ) errors.duration_seconds = "Use 60 to 31536000 seconds.";
  if (
    c.deadline_at !== undefined &&
    (typeof c.deadline_at !== "string" ||
      !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(c.deadline_at) ||
      !Number.isFinite(Date.parse(c.deadline_at)))
  ) errors.deadline_at = "Use an ISO 8601 datetime with timezone.";
  const questions = c.questions;
  const keyPattern = /^[a-zA-Z0-9_-]{1,64}$/;
  if (!Array.isArray(questions) || !questions.length || questions.length > 30) {
    errors.questions = "Provide 1 to 30 questions.";
  } else {
    const keys = new Set();
    questions.forEach((q, i) => {
      const field = `questions.${i}`;
      if (!q || typeof q !== "object" || Array.isArray(q)) {
        errors[field] = "Invalid question.";
        return;
      }
      if (
        Object.keys(q).some((k) =>
          !["question_key", "prompt", "type", "reason_required", "options"]
            .includes(k)
        )
      ) errors[field] = "Unknown question field.";
      if (
        typeof q.question_key !== "string" ||
        !keyPattern.test(q.question_key) || keys.has(q.question_key)
      ) errors[field] = "Question keys must be valid and unique.";
      keys.add(q.question_key);
      if (
        q.type !== "single_choice" || q.reason_required !== true ||
        typeof q.prompt !== "string" || !q.prompt.trim() ||
        q.prompt.length > 2000
      ) {
        errors[field] =
          "Single choice, prompt and required reason are mandatory.";
      }
      if (
        !Array.isArray(q.options) || q.options.length < 2 ||
        q.options.length > 20
      ) errors[field] = "Provide 2 to 20 options.";
      else {
        const optionKeys = new Set(), labels = new Set();
        for (const o of q.options) {
          if (
            !o || typeof o !== "object" || Object.keys(o).some((k) =>
              !["option_key", "label"].includes(k)
            ) || typeof o.option_key !== "string" ||
            !keyPattern.test(o.option_key) || optionKeys.has(o.option_key) ||
            typeof o.label !== "string" || !o.label.trim() ||
            o.label.length > 1000 || labels.has(o.label.trim())
          ) {
            errors[field] =
              "Options need unique keys and non-empty distinct labels.";
            continue;
          }
          optionKeys.add(o.option_key);
          labels.add(o.label.trim());
        }
      }
    });
  }
  if (Object.keys(errors).length) {
    throw new ApiError(
      422,
      "invalid_config",
      "Invalid task configuration.",
      errors,
    );
  }
  return c;
}
export function publicTask(row: Record<string, any>) {
  const { budget_amount_minor: _budget, ...config } = row.published_config;
  return {
    id: row.id,
    slug: row.public_slug,
    status: row.status,
    ...config,
    deadline_at: row.deadline_at,
    published_at: row.published_at,
    accepting_submissions: row.status === "published" &&
      Date.parse(row.deadline_at) > Date.now(),
    payment_rules:
      "Submission does not guarantee acceptance or payment. The publisher reviews the evidence and confirms payment.",
  };
}
