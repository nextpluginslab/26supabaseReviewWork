import { describe, expect, it } from "vitest";
import { approveInResults, getBudget, getDistribution, money } from "./api";
import { createFixture } from "./fixtures";
describe("mock results contract", () => {
  it("preserves cents in rewards and budgets", () => {
    expect(money(1050)).toBe("$10.50");
    expect(money(0)).toBe("$0");
  });
  it("counts every latest formal answer, including unaccepted feedback", () => {
    const data = createFixture("a");
    for (const q of data.task.questions) {
      expect(
        getDistribution(data, q.id).reduce((sum, o) => sum + o.count, 0),
      ).toBe(data.submissions.length);
    }
    expect(getDistribution(data, "ease").map((o) => o.count)).toEqual([
      7,
      3,
      2,
    ]);
    expect(getDistribution(data, "clarity").map((o) => o.count)).toEqual([
      5,
      5,
      2,
    ]);
  });
  it("protects confirmation with login and disallows declined feedback", () => {
    const data = createFixture("a");
    expect(() => approveInResults(data, "FB-001", false)).toThrow("Sign in");
    expect(() => approveInResults(data, "FB-012", true)).toThrow("declined");
    expect(getBudget(data)).toEqual({
      paid: 3000,
      pending: 1000,
      remaining: 8000,
    });
  });
  it("confirms a reward once, retaining pending budget reservations", () => {
    const data = createFixture("a");
    approveInResults(data, "FB-001", true);
    approveInResults(data, "FB-001", true);
    expect(getBudget(data)).toEqual({
      paid: 4000,
      pending: 1000,
      remaining: 7000,
    });
    expect(data.submissions[0].payment).toBe("paid");
  });
  it("never overspends the last available reward", () => {
    const data = createFixture("a");
    data.task.budget = 5000;
    approveInResults(data, "FB-001", true);
    expect(() => approveInResults(data, "FB-002", true)).toThrow("budget");
    expect(data.submissions[1].status).toBe("awaiting_publisher");
    expect(getBudget(data).remaining).toBe(0);
  });
  it("accepts a zero reward without generating payment", () => {
    const data = createFixture("free");
    data.task.reward = 0;
    data.task.budget = 0;
    expect(approveInResults(data, "FB-001", true).payment).toBe("not_required");
    expect(getBudget(data)).toEqual({ paid: 0, pending: 0, remaining: 0 });
  });
  it("includes zero-vote options and supports an empty results set", () => {
    const data = createFixture("empty");
    data.submissions = [];
    expect(getDistribution(data, "ease").map((o) => o.count)).toEqual([
      0,
      0,
      0,
    ]);
    expect(getBudget(data).remaining).toBe(data.task.budget);
  });
});

describe("live AI assessment mapping", () => {
  it("preserves zero scores and the evidence reasoning; legacy summaries remain unscored", async () => {
    const { mapRow } = await import("./api");
    const row = {
      id: "s1",
      submission_no: "FW-example",
      current_revision_id: "r1",
      first_submitted_at: "2026-10-03T00:00:00Z",
      processing_status: "awaiting_publisher",
      payment_status: "awaiting_confirmation",
      version: 1,
      current_revision: {
        id: "r1",
        operation_notes: "random",
        answers: [],
        evidence_ids: [],
        ai: {
          status: "succeeded",
          summary: {
            summary: "Unrelated image",
            confidence_score: 0,
            confidence_reason: "No product evidence",
            evidence_observations: [{ text: "Pool photo", source_refs: [] }],
            suggested_followups: [{
              text: "Upload an app screenshot",
              source_refs: [],
            }],
            limitations: ["Cannot verify testing"],
            findings: [],
          },
        },
      },
    };
    const mapped = mapRow(
      row as unknown as import("@/lib/contracts").RemoteSubmission,
    );
    expect(mapped.ai.confidenceScore).toBe(0);
    expect(mapped.ai.confidenceReason).toBe("No product evidence");
    expect(mapped.ai.observations).toEqual(["Pool photo"]);
    expect(mapped.ai.followups).toEqual(["Upload an app screenshot"]);
    expect(mapped.status).toBe("awaiting_publisher");
    const legacy = {
      ...row,
      current_revision: {
        ...row.current_revision,
        ai: { status: "succeeded", summary: { summary: "Old summary" } },
      },
    };
    expect(
      mapRow(legacy as unknown as import("@/lib/contracts").RemoteSubmission).ai
        .confidenceScore,
    ).toBeUndefined();
  });
});
