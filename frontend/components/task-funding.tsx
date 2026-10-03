"use client";
import { useCallback, useEffect, useState } from "react";
import { request, mutate } from "@/lib/api-client";
import type { TaskRow } from "@/lib/contracts";
export function TaskFunding({
  taskId,
  onUpdate,
}: {
  taskId: string;
  onUpdate: () => Promise<void>;
}) {
  const [task, setTask] = useState<TaskRow>(),
    [funding, setFunding] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const { task: t } = await request<{ task: TaskRow }>(
        "api",
        `/tasks/${taskId}`,
      );
      setTask(t);
      if (t.config.reward_amount_minor > 0) {
        const f = await request<{ funding_state: string }>(
          "payments",
          `/tasks/${taskId}/funding`,
        );
        setFunding(f.funding_state);
      } else setFunding("not_required");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [taskId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function action(name: "fund" | "publish" | "close") {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      if (name === "fund") {
        const r = await mutate<{ url: string }>(
          "payments",
          `/tasks/${task.id}/funding-sessions`,
          {},
        );
        if (!r.url.startsWith("https://"))
          throw new Error("Invalid Checkout link.");
        location.assign(r.url);
      } else {
        await mutate("api", `/tasks/${task.id}/${name}`, {
          version: task.version,
        });
        await load();
        await onUpdate();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="live-panel">
      <p>
        Task:{" "}
        {task?.status === "published"
          ? "Published"
          : task?.status === "closed"
            ? "Closed"
            : task?.status === "draft"
              ? "Draft"
              : "Loading…"}{" "}
        · Funding:{" "}
        {(
          {
            not_required: "No funding required",
            funded: "Funded",
            pending: "Awaiting confirmation",
            unfunded: "Awaiting funding",
          } as Record<string, string>
        )[funding] || "Not available"}
      </p>
      {task?.status === "draft" ? (
        <>
          <p>Complete test funding, then publish this task.</p>
          {task.config.reward_amount_minor > 0 && funding !== "funded" && (
            <button disabled={busy} onClick={() => void action("fund")}>
              Fund in Stripe Sandbox
            </button>
          )}
          <button
            disabled={busy || !["funded", "not_required"].includes(funding)}
            onClick={() => void action("publish")}
          >
            Publish task
          </button>
          <button onClick={() => void load()}>Check funding</button>
          <a href={`/tasks/${task.id}/edit`}>Edit draft</a>
        </>
      ) : (
        task && (
          <>
            <a href={`/tasks/${task.public_slug}`}>Open public task</a>
            {task.status === "published" && (
              <button disabled={busy} onClick={() => void action("close")}>
                Close new submissions
              </button>
            )}
          </>
        )
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
