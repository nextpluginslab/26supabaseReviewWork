import { describe, expect, it } from "vitest";
import { blankDraft, cents, validateDraft, defaultDeadline } from "./model";
const valid = () => ({
  ...blankDraft(),
  title: "Test the editor",
  appName: "Editor",
  appUrl: "https://example.com",
  instructions: "Open the editor",
  steps: "Create a document",
  evidenceInstructions: "Show the document",
  reward: "5.25",
  budget: "21",
  deadline: "2099-01-01T12:00",
  questions: [
    {
      id: "q",
      title: "Was it clear?",
      options: [
        { id: "a", label: "Yes" },
        { id: "b", label: "No" },
      ],
    },
  ],
});
describe("task publishing", () => {
  it("defaults to zero reward, three days later, and no questions", () => {
    expect(blankDraft().reward).toBe("0");
    expect(blankDraft().budget).toBe("0");
    expect(blankDraft().questions).toEqual([]);
    expect(defaultDeadline(new Date(2026, 9, 30, 14, 30))).toBe(
      "2026-11-02T14:30",
    );
  });
  it("publishes with only the required fields and default evidence", () => {
    expect(
      validateDraft({
        ...blankDraft(),
        appName: "App",
        appUrl: "https://apps.apple.com/app/id123456",
        reward: "5",
        budget: "5",
        deadline: "2099-01-01T12:00",
      }),
    ).toEqual({});
  });
  it("requires configuration and future deadline", () => {
    expect(Object.keys(validateDraft(blankDraft()))).toEqual([
      "appName",
      "appUrl",
    ]);
    expect(
      validateDraft({ ...valid(), deadline: "2000-01-01T12:00" }).deadline,
    ).toBeTruthy();
  });
  it("accepts free tasks and exact cents", () => {
    expect(cents("5.25")).toBe(525);
    expect(cents("1.999")).toBeNull();
    expect(cents("-1")).toBeNull();
    expect(validateDraft({ ...valid(), reward: "0", budget: "0" })).toEqual({});
  });
  it("requires sufficient budget and HTTPS", () => {
    expect(validateDraft({ ...valid(), budget: "" }).budget).toBeTruthy();
    const errors = validateDraft({
      ...valid(),
      budget: "1",
      appUrl: "javascript:alert(1)",
    });
    expect(errors.budget).toBeTruthy();
    expect(errors.appUrl).toBeTruthy();
  });
  it("rejects duplicate options and missing evidence", () => {
    const draft = valid();
    draft.questions[0].options[1].label = " YES ";
    expect(validateDraft({ ...draft, evidenceTypes: [] }).q).toBeTruthy();
    expect(
      validateDraft({ ...draft, evidenceTypes: [] }).evidenceTypes,
    ).toBeTruthy();
  });
  it("accepts a complete configurable task", () =>
    expect(validateDraft(valid())).toEqual({}));
});
