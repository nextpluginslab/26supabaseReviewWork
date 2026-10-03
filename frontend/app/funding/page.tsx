"use client";
import { useEffect, useState } from "react";
import { AuthPanel } from "@/components/auth-panel";
import { request, mutate } from "@/lib/api-client";
import type { TaskRow } from "@/lib/contracts";
import "./funding.css";

type Funding = {
  funding_state: string;
  budget_amount_minor: number;
  remaining_amount_minor: number;
  pending_amount_minor: number;
  paid_amount_minor: number;
};
type Entry = { task: TaskRow; funding: Funding | null; error?: string };
const money = (amount: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount / 100);
const states: Record<string, string> = {
  funded: "Funded",
  pending: "Awaiting payment",
  unfunded: "Not funded",
  not_required: "Free task",
};
export default function FundingPage() {
  return (
    <AuthPanel required>
      <FundingContent />
    </AuthPanel>
  );
}
function FundingContent() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const tasks: TaskRow[] = [];
      let cursor: string | null = null;
      do {
        const page: { tasks: TaskRow[]; next_cursor: string | null } =
          await request(
            "api",
            `/tasks?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          );
        tasks.push(...page.tasks);
        cursor = page.next_cursor;
      } while (cursor);
      const rows = await Promise.all(
        tasks.map(async (task) => {
          if (task.config.reward_amount_minor === 0)
            return { task, funding: null };
          try {
            const funding = await request<Funding>(
              "payments",
              `/tasks/${task.id}/funding`,
            );
            if (
              ![
                funding.budget_amount_minor,
                funding.remaining_amount_minor,
                funding.pending_amount_minor,
                funding.paid_amount_minor,
              ].every(Number.isSafeInteger)
            )
              throw new Error("Balance is unavailable. Please refresh.");
            return { task, funding };
          } catch (e) {
            return { task, funding: null, error: (e as Error).message };
          }
        }),
      );
      setEntries(rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function act(entry: Entry, action: "fund" | "publish" | "close") {
    setBusy(entry.task.id);
    setError("");
    try {
      if (action === "fund") {
        const { url } = await mutate<{ url: string }>(
          "payments",
          `/tasks/${entry.task.id}/funding-sessions`,
          {},
        );
        const checkout = new URL(url);
        if (
          checkout.protocol !== "https:" ||
          checkout.hostname !== "checkout.stripe.com"
        )
          throw new Error("Invalid Stripe Checkout link.");
        window.location.assign(checkout.href);
      } else {
        await mutate("api", `/tasks/${entry.task.id}/${action}`, {
          version: entry.task.version,
        });
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const available = !loading && !error && !entries.some((e) => e.error);
  const funded = entries.filter((e) => e.funding?.funding_state === "funded");
  const sum = (
    key: keyof Pick<
      Funding,
      "remaining_amount_minor" | "pending_amount_minor" | "paid_amount_minor"
    >,
  ) => funded.reduce((total, entry) => total + entry.funding![key], 0);
  return (
    <main className="funding-page">
      <div className="funding-heading">
        <div>
          <h1>Funding</h1>
          <p>Fund your tasks and track review payments.</p>
        </div>
        <button disabled={loading || !!busy} onClick={() => void load()}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="funding-mode">Stripe Sandbox · Test payments only</div>
      <section className="funding-balances" aria-label="Funding balances">
        {(
          [
            ["Available balance", "remaining_amount_minor"],
            ["Pending payouts", "pending_amount_minor"],
            ["Paid out", "paid_amount_minor"],
          ] as const
        ).map(([label, key]) => (
          <div key={key}>
            <span>{label}</span>
            <strong>{available ? money(sum(key)) : "—"}</strong>
            <small>USD</small>
          </div>
        ))}
      </section>
      <p className="funding-note">
        Balance is reserved for the task it funded. Unpaid budgets are not
        included.
      </p>
      {error && (
        <p className="funding-error" role="alert">
          {error}
        </p>
      )}
      {!loading && entries.some((e) => e.error) && (
        <p className="funding-error" role="alert">
          Some balances could not be loaded. Refresh to try again.
        </p>
      )}
      <section className="funding-tasks" aria-labelledby="funding-tasks-title">
        <h2 id="funding-tasks-title">Task funding</h2>
        {loading ? (
          <p role="status">Loading balances…</p>
        ) : !entries.length && !error ? (
          <div className="funding-empty">
            <p>No tasks yet.</p>
            <a href="/tasks/new">Create a task</a>
          </div>
        ) : (
          entries.map((entry) => {
            const { task, funding } = entry;
            const free = task.config.reward_amount_minor === 0;
            const ready = free || funding?.funding_state === "funded";
            return (
              <article className="funding-task" key={task.id} id={task.id}>
                <div className="funding-task-title">
                  <div>
                    <a href={`/tasks/${task.id}/results`}>
                      {task.config.title}
                    </a>
                    <p>{task.status}</p>
                  </div>
                  <span className="funding-badge">
                    {entry.error
                      ? "Unavailable"
                      : states[
                          free ? "not_required" : funding?.funding_state || ""
                        ] || "Unknown"}
                  </span>
                </div>
                {!free && (
                  <dl>
                    <div>
                      <dt>Task budget</dt>
                      <dd>{money(task.config.budget_amount_minor ?? 0)}</dd>
                    </div>
                    <div>
                      <dt>Available balance</dt>
                      <dd>
                        {entry.error
                          ? "—"
                          : money(ready ? funding!.remaining_amount_minor : 0)}
                      </dd>
                    </div>
                    <div>
                      <dt>Per review</dt>
                      <dd>{money(task.config.reward_amount_minor)}</dd>
                    </div>
                  </dl>
                )}
                {entry.error && <p className="funding-error">{entry.error}</p>}
                <div className="funding-actions">
                  {!free &&
                    !ready &&
                    !entry.error &&
                    task.status === "draft" && (
                      <button
                        className="funding-primary"
                        disabled={!!busy}
                        onClick={() => void act(entry, "fund")}
                      >
                        {busy === task.id ? "Opening…" : "Fund with Stripe"}
                      </button>
                    )}
                  {task.status === "draft" && ready && (
                    <button
                      className="funding-primary"
                      disabled={!!busy}
                      onClick={() => void act(entry, "publish")}
                    >
                      Publish task
                    </button>
                  )}
                  {task.status === "draft" && (
                    <a href={`/tasks/${task.id}/edit`}>Edit task</a>
                  )}
                  {task.status === "published" && (
                    <button
                      disabled={!!busy}
                      onClick={() => void act(entry, "close")}
                    >
                      Close new submissions
                    </button>
                  )}
                  <a href={`/tasks/${task.id}/results`}>View results</a>
                </div>
              </article>
            );
          })
        )}
      </section>
    </main>
  );
}
