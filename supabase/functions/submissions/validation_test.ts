import {
  ApiError,
  canonical,
  matchesSignature,
  validateBody,
} from "./validation.ts";
const id = "11111111-1111-4111-8111-111111111111";
const feedback = {
  answers: [{
    question_key: "choice",
    selected_option_key: "no",
    reason: "Not useful for me",
  }],
  operation_notes: "I got stuck.",
  evidence_ids: [id],
};
function rejects(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) return;
    throw e;
  }
  throw new Error("Expected validation error");
}
Deno.test("negative feedback and blocker notes are valid", () => {
  validateBody("submit", feedback);
});
Deno.test("missing reasons, duplicated questions and forged fields are rejected", () => {
  rejects(() =>
    validateBody("submit", {
      ...feedback,
      answers: [{ ...feedback.answers[0], reason: "  " }],
    })
  );
  rejects(() =>
    validateBody("submit", {
      ...feedback,
      answers: [...feedback.answers, ...feedback.answers],
    })
  );
  rejects(() => validateBody("submit", { ...feedback, tester_id: id }));
  rejects(() =>
    validateBody("submit", {
      ...feedback,
      answers: [{ ...feedback.answers[0], reason_required: false }],
    })
  );
});
Deno.test("evidence must be distinct nonempty UUIDs", () => {
  for (
    const evidence_ids of [[], [id, id], ["bad"], [id, ...Array(10).fill(id)]]
  ) rejects(() => validateBody("submit", { ...feedback, evidence_ids }));
});
Deno.test("revision and decision require both concurrency tokens", () => {
  rejects(() => validateBody("revise", feedback));
  rejects(() =>
    validateBody("decide", { action: "accept", expected_revision_id: id })
  );
  validateBody("revise", {
    ...feedback,
    expected_revision_id: id,
    expected_version: 2,
  });
});
Deno.test("request_changes and decline require explicit nonblank reasons", () => {
  for (const action of ["decline", "request_changes"]) {
    rejects(() =>
      validateBody("decide", {
        action,
        reason: " ",
        expected_revision_id: id,
        expected_version: 1,
      })
    );
  }
});
Deno.test("uploads reject SVG, empty files, oversize and noninteger sizes", () => {
  const upload = {
    task_id: id,
    name: "evidence.png",
    mime_type: "image/png",
    size_bytes: 100,
  };
  validateBody("upload", upload);
  for (const size_bytes of [0, -1, 1.5, 52428801]) {
    rejects(() => validateBody("upload", { ...upload, size_bytes }));
  }
  rejects(() =>
    validateBody("upload", { ...upload, mime_type: "image/svg+xml" })
  );
});
Deno.test("file signatures reject disguised text and truncated files", () => {
  if (
    matchesSignature(
      new TextEncoder().encode("<html>pretend png</html>"),
      "image/png",
    )
  ) throw Error("Accepted HTML");
  if (matchesSignature(new Uint8Array([255, 216, 255]), "image/jpeg")) {
    throw Error("Accepted truncated JPEG");
  }
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  if (!matchesSignature(bytes, "image/png")) throw Error("Rejected PNG header");
});
Deno.test("request hashing is key-order independent, array-order sensitive", () => {
  if (
    canonical({ b: 2, a: { d: 4, c: 3 } }) !==
      canonical({ a: { c: 3, d: 4 }, b: 2 })
  ) throw Error("Unstable object hash");
  if (canonical([1, 2]) === canonical([2, 1])) throw Error("Lost array order");
});

Deno.test("empty answers are valid for a zero-question task; SQL verifies coverage", () => {
  validateBody("submit", { ...feedback, answers: [] });
});
