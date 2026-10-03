import { describe, expect, it } from "vitest";
import { taskFixture } from "./fixtures";
import { MAX_FILE_SIZE, validateFeedback, validateFile } from "./validation";
import type { Feedback } from "./types";
const task = taskFixture("demo");
const valid: Feedback = {
  email: "tester@example.com",
  notes: "I got stuck",
  evidence: [
    {
      id: "e",
      name: "blocked.png",
      size: 100,
      type: "image/png",
      path: "demo/e/blocked.png",
    },
  ],
  answers: Object.fromEntries(
    task.questions.map((q) => [
      q.id,
      { optionId: q.options.at(-1)!.id, reason: "The controls were unclear." },
    ]),
  ),
};
describe("feedback validation", () => {
  it("accepts negative answers and blocker feedback", () =>
    expect(validateFeedback(task, valid, false, 0)).toEqual({}));
  it("requires every answer and a non-whitespace reason", () => {
    const incomplete = structuredClone(valid);
    delete incomplete.answers[task.questions[0].id];
    incomplete.answers[task.questions[1].id].reason = "  ";
    expect(Object.keys(validateFeedback(task, incomplete, false, 0))).toEqual(
      task.questions.slice(0, 2).map((q) => q.id),
    );
  });
  it("rejects an option from another question", () => {
    const invalid = structuredClone(valid);
    invalid.answers[task.questions[0].id].optionId = "no";
    expect(
      validateFeedback(task, invalid, false, 0)[task.questions[0].id],
    ).toBeTruthy();
  });
  it("closes first submissions at the deadline but permits revisions", () => {
    const time = new Date(task.deadline).getTime();
    expect(validateFeedback(task, valid, false, time).deadline).toBeTruthy();
    expect(validateFeedback(task, valid, true, time + 1000)).toEqual({});
  });
  it("requires evidence and valid email", () => {
    const result = validateFeedback(
      task,
      { ...valid, email: "invalid", evidence: [] },
      false,
      0,
    );
    expect(result.email).toBeTruthy();
    expect(result.evidence).toBeTruthy();
  });
  it("renders validation from arbitrary question configuration", () => {
    const custom = {
      ...task,
      questions: [
        {
          id: "custom",
          title: "Custom",
          options: [
            { id: "one", label: "One" },
            { id: "two", label: "Two" },
          ],
        },
      ],
    };
    expect(
      validateFeedback(
        custom,
        {
          ...valid,
          answers: { custom: { optionId: "two", reason: "My experience" } },
        },
        false,
        0,
      ),
    ).toEqual({});
  });
});
describe("evidence validation", () => {
  it("rejects empty, unsupported, and oversized files", () => {
    expect(validateFile({ size: 0, type: "image/png" }, task)).toBeTruthy();
    expect(validateFile({ size: 10, type: "text/plain" }, task)).toBeTruthy();
    expect(
      validateFile({ size: MAX_FILE_SIZE + 1, type: "video/mp4" }, task),
    ).toBeTruthy();
  });
  it("respects publisher evidence types", () => {
    expect(
      validateFile(
        { size: 10, type: "video/mp4" },
        { ...task, evidenceTypes: ["image"] },
      ),
    ).toBeTruthy();
    expect(validateFile({ size: 10, type: "video/mp4" }, task)).toBeNull();
  });
});
