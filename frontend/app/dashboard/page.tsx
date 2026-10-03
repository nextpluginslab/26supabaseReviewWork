"use client";
import { useEffect, useState } from "react";
import { AuthPanel } from "@/components/auth-panel";
import { request } from "@/lib/api-client";
import type { TaskRow } from "@/lib/contracts";
export default function Dashboard() {
  return (
    <AuthPanel required>
      <Tasks />
    </AuthPanel>
  );
}
function Tasks() {
  const [items, setItems] = useState<TaskRow[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load(next?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await request<{
        tasks: TaskRow[];
        next_cursor: string | null;
      }>("api", `/tasks?limit=20${next ? `&cursor=${next}` : ""}`);
      setItems((old) => (next ? [...old, ...result.tasks] : result.tasks));
      setCursor(result.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <main className="live-panel">
      <h1>My tasks</h1>
      <a href="/tasks/new">Create task</a>
      <button disabled={busy} onClick={() => void load()}>
        Refresh
      </button>
      {error && <p role="alert">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.id}>
              <td>{t.config.title}</td>
              <td>{t.status}</td>
              <td>
                <a href={`/tasks/${t.id}/results`}>Results</a> ·{" "}
                {t.status === "draft" ? (
                  <a href={`/tasks/${t.id}/edit`}>Edit</a>
                ) : (
                  <a href={`/tasks/${t.public_slug}`}>Public link</a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!busy && !items.length && !error && <p>No tasks yet.</p>}
      {cursor && (
        <button disabled={busy} onClick={() => void load(cursor)}>
          Load more
        </button>
      )}
    </main>
  );
}
