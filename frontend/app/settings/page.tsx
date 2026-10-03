"use client";
import { useEffect, useState } from "react";
import { AuthPanel } from "@/components/auth-panel";
import { request, mutate } from "@/lib/api-client";
type Key = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  revoked_at: string | null;
  expires_at: string;
};
type Notice = {
  id: string;
  title: string;
  body: string;
  task_id: string;
  entity_id: string;
  read_at: string | null;
};
export default function Settings() {
  return (
    <AuthPanel required>
      <Content />
    </AuthPanel>
  );
}
function Content() {
  const [keys, setKeys] = useState<Key[]>([]),
    [keyCursor, setKeyCursor] = useState<string | null>(null),
    [name, setName] = useState(""),
    [secret, setSecret] = useState(""),
    [scopes, setScopes] = useState<string[]>(["tasks:read"]),
    [notices, setNotices] = useState<Notice[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [unread, setUnread] = useState(0),
    [connect, setConnect] = useState<{
      ready: boolean;
      currently_due?: string[];
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadKeys(next?: string) {
    const r = await request<{ api_keys: Key[]; next_cursor: string | null }>(
      "api-keys",
      `/?limit=20${next ? `&cursor=${next}` : ""}`,
    );
    setKeys((old) => (next ? [...old, ...r.api_keys] : r.api_keys));
    setKeyCursor(r.next_cursor);
  }
  async function loadNotices(next?: string) {
    const r = await request<{
      items: Notice[];
      next_cursor: string | null;
      unread_count: number;
    }>(
      "notifications",
      `/me/notifications?limit=20${next ? `&cursor=${next}` : ""}`,
    );
    setNotices((old) => (next ? [...old, ...r.items] : r.items));
    setCursor(r.next_cursor);
    setUnread(r.unread_count);
  }
  async function onboarding() {
    const r = await mutate<{ url: string }>(
      "payments",
      "/me/connect-onboarding",
      {},
    );
    if (!r.url.startsWith("https://"))
      throw new Error("Invalid onboarding URL.");
    location.assign(r.url);
  }
  async function account() {
    setConnect(await request("payments", "/me/connect-account"));
  }
  useEffect(() => {
    void run(async () => {
      await loadKeys();
      await loadNotices();
    });
    const result = new URLSearchParams(location.search).get("connect");
    if (result === "return") void run(account);
    if (result === "refresh") void run(onboarding);
  }, []);
  return (
    <main className="live-panel">
      <h1>Settings</h1>
      {error && <p role="alert">{error}</p>}
      <section>
        <h2>Test payments</h2>
        <p>Stripe Sandbox only. No bank payout.</p>
        {connect && (
          <p>
            {connect.ready
              ? "Ready to receive test transfers"
              : "Account setup incomplete"}{" "}
            {connect.currently_due?.join(", ")}
          </p>
        )}
        <button disabled={busy} onClick={() => void run(account)}>
          Check account status
        </button>
        <button disabled={busy} onClick={() => void run(onboarding)}>
          Set up test receiving account
        </button>
      </section>
      <section>
        <h2>Agent API access</h2>
        <p>Keys cannot accept submissions or authorize payments.</p>
        <label>
          Key name{" "}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
        </label>
        {[
          "tasks:read",
          "tasks:write",
          "submissions:read",
          "insights:read",
          "insights:write",
        ].map((scope) => (
          <label key={scope}>
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={(e) =>
                setScopes((old) =>
                  e.target.checked
                    ? [...old, scope]
                    : old.filter((x) => x !== scope),
                )
              }
            />
            {scope}
          </label>
        ))}
        <button
          disabled={busy || !name.trim() || !scopes.length}
          onClick={() =>
            void run(async () => {
              setSecret("");
              const r = await request<{ key: string }>("api-keys", "/", {
                method: "POST",
                body: { name, scopes },
              });
              setSecret(r.key);
              await loadKeys();
            })
          }
        >
          Create key
        </button>
        <button disabled={busy} onClick={() => void run(() => loadKeys())}>
          Refresh keys
        </button>
        {secret && (
          <div>
            <p>
              Copy now. This key is shown once and is not saved in this browser.
            </p>
            <pre>{secret}</pre>
            <button
              onClick={() =>
                void run(() => navigator.clipboard.writeText(secret))
              }
            >
              Copy key
            </button>
            <button onClick={() => setSecret("")}>Hide key</button>
          </div>
        )}
        {keys.map((k) => (
          <p key={k.id}>
            {k.name} · {k.key_prefix}… · {k.scopes.join(", ")} ·{" "}
            {k.revoked_at
              ? "Revoked"
              : new Date(k.expires_at) < new Date()
                ? "Expired"
                : "Active"}
            {!k.revoked_at && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await request("api-keys", `/${k.id}`, { method: "DELETE" });
                    setSecret("");
                    await loadKeys();
                  })
                }
              >
                Revoke
              </button>
            )}
          </p>
        ))}
        {keyCursor && (
          <button
            disabled={busy}
            onClick={() => void run(() => loadKeys(keyCursor))}
          >
            More keys
          </button>
        )}
      </section>
      <section>
        <h2>Notifications ({unread} unread)</h2>
        <button disabled={busy} onClick={() => void run(() => loadNotices())}>
          Refresh notifications
        </button>
        {notices.map((n) => (
          <article key={n.id}>
            <strong>{n.title}</strong>
            <p>{n.body}</p>
            <a href={`/submissions/${n.entity_id}`}>View submission</a>
            {!n.read_at && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await request(
                      "notifications",
                      `/notifications/${n.id}/read`,
                      { method: "POST" },
                    );
                    await loadNotices();
                  })
                }
              >
                Mark read
              </button>
            )}
          </article>
        ))}
        {cursor && (
          <button
            disabled={busy}
            onClick={() => void run(() => loadNotices(cursor))}
          >
            More notifications
          </button>
        )}
      </section>
    </main>
  );
}
