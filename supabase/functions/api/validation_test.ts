import { ApiError, publicTask, validateConfig } from "./validation.ts";
const config = () => ({
  title: "Try a product",
  app_name: "Example",
  app_type: "web",
  app_url: "https://example.com",
  experience_instructions: "Open the product",
  task_description: "Try onboarding",
  evidence_types: ["image"],
  evidence_instructions: "Show the result",
  questions: [{
    question_key: "ease",
    prompt: "Was it easy?",
    type: "single_choice",
    reason_required: true,
    options: [{ option_key: "yes", label: "Yes" }, {
      option_key: "no",
      label: "No",
    }],
  }],
  reward_amount_minor: 0,
  budget_amount_minor: 0,
  currency: "USD",
  duration_seconds: 3600,
  display_timezone: "America/Phoenix",
});
Deno.test("accept configurable questions and zero reward", () => {
  validateConfig(config());
});
for (
  const [name, change] of Object.entries({
    "owner spoofing": { publisher_id: "another-user" },
    "budget smaller than reward": {
      reward_amount_minor: 200,
      budget_amount_minor: 100,
    },
    "non-integer money": { reward_amount_minor: 0.5 },
    "unsafe product URL": { app_url: "javascript:alert(1)" },
    "ambiguous deadline": { deadline_at: "2030-01-01T00:00:00Z" },
    "bad timezone": { display_timezone: "invalid/zone" },
    "empty questionnaire": { questions: [] },
    "bad evidence type": { evidence_types: ["executable"] },
  })
) {
  Deno.test(`reject ${name}`, () => {
    try {
      validateConfig({ ...config(), ...change });
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) return;
      throw e;
    }
    throw new Error("Expected rejection");
  });
}
Deno.test("reject optional reasons and duplicate options", () => {
  const c = config();
  c.questions[0].reason_required = false;
  c.questions[0].options[1].option_key = "yes";
  try {
    validateConfig(c);
  } catch (e) {
    if (e instanceof ApiError) return;
    throw e;
  }
  throw new Error("Expected rejection");
});
Deno.test("public projection strips owner, budget and internal config", () => {
  const p = publicTask({
    id: "id",
    public_slug: "slug",
    status: "published",
    published_config: config(),
    deadline_at: "2000-01-01T00:00:00Z",
    publisher_id: "secret",
    question_registry: {},
    config: { secret: "hidden" },
  });
  if (
    "publisher_id" in p || "budget_amount_minor" in p || "config" in p ||
    p.accepting_submissions
  ) throw new Error("Public data leak or deadline bypass");
});
