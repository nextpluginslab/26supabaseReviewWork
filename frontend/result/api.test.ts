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
    for (const q of data.task.questions)
      expect(
        getDistribution(data, q.id).reduce((sum, o) => sum + o.count, 0),
      ).toBe(data.submissions.length);
    expect(getDistribution(data, "ease").map((o) => o.count)).toEqual([
      7, 3, 2,
    ]);
    expect(getDistribution(data, "clarity").map((o) => o.count)).toEqual([
      5, 5, 2,
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
      0, 0, 0,
    ]);
    expect(getBudget(data).remaining).toBe(data.task.budget);
  });
});
