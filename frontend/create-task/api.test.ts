import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, mutate, request } from "@/lib/api-client";
import { createTask } from "./api";
import { blankDraft } from "./model";

vi.mock("@/lib/supabase", () => ({
  session: vi.fn(async () => ({ user: { id: "owner" } })),
}));
vi.mock("@/lib/api-client", async (original) => ({
  ...(await original<typeof import("@/lib/api-client")>()),
  mutate: vi.fn(),
  request: vi.fn(),
}));

const draft = () => ({
  ...blankDraft(), appName: "Notebook", appUrl: "https://example.com",
  reward: "5", budget: "50",
});
const task = { id: "task-1", public_slug: "public-slug", status: "draft", version: 1 };
const published = { ...task, status: "published", version: 2 };
let storage: Map<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  storage = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("location", { origin: "https://reviewwork.test", assign: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("create and publish", () => {
  it("publishes a funded paid task instead of leaving it as a draft", async () => {
    vi.mocked(mutate).mockResolvedValueOnce({ task }).mockResolvedValueOnce({ task: published });
    const result = await createTask(draft());
    expect(mutate).toHaveBeenLastCalledWith("api", "/tasks/task-1/publish", { version: 1 });
    expect(result.needsFunding).toBe(false);
    expect(result.testUrl).toBe("https://reviewwork.test/tasks/public-slug");
    expect(location.assign).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it("routes unfunded tasks to funding and publishes the same draft after funding", async () => {
    const input = draft();
    vi.mocked(mutate).mockResolvedValueOnce({ task }).mockRejectedValueOnce(
      new ApiError(409, "funding_required", "Complete funding first."),
    );
    expect((await createTask(input)).needsFunding).toBe(true);
    expect(location.assign).toHaveBeenCalledWith("/funding#task-1");
    expect(storage.size).toBe(1);
    vi.mocked(request).mockResolvedValueOnce({ task });
    vi.mocked(mutate).mockResolvedValueOnce({ task: published });
    expect((await createTask(input)).needsFunding).toBe(false);
    expect(request).toHaveBeenCalledWith("api", "/tasks/task-1");
    expect(mutate).toHaveBeenCalledTimes(3);
    expect(storage.size).toBe(0);
  });

  it("surfaces publication failures without reporting success or redirecting", async () => {
    vi.mocked(mutate).mockResolvedValueOnce({ task }).mockRejectedValueOnce(
      new ApiError(422, "deadline_expired", "Publication requires a future deadline."),
    );
    await expect(createTask(draft())).rejects.toThrow("future deadline");
    expect(location.assign).not.toHaveBeenCalled();
    expect(storage.size).toBe(1);
  });

  it("still publishes free tasks", async () => {
    vi.mocked(mutate).mockResolvedValueOnce({ task }).mockResolvedValueOnce({ task: published });
    expect((await createTask({ ...draft(), reward: "0", budget: "0" })).needsFunding).toBe(false);
    expect(mutate).toHaveBeenLastCalledWith("api", "/tasks/task-1/publish", { version: 1 });
  });
});
