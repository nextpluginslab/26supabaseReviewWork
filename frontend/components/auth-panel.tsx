"use client";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { session, supabase } from "@/lib/supabase";
export function AuthPanel({
  children,
  required = false,
  onChange,
}: {
  children?: ReactNode;
  required?: boolean;
  onChange?: (value: Session | null) => void;
}) {
  const [user, setUser] = useState<Session | null>(null),
    [ready, setReady] = useState(false),
    [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let cancel = () => {};
    try {
      const client = supabase();
      const sub = client.auth.onAuthStateChange((_event, s) => {
        if (active) {
          setUser(s);
          onChange?.(s);
        }
      });
      cancel = () => sub.data.subscription.unsubscribe();
      session()
        .then((s) => {
          if (active) {
            setUser(s);
            setReady(true);
            onChange?.(s);
          }
        })
        .catch((e) => {
          if (active) {
            setError(e.message);
            setReady(true);
          }
        });
    } catch (e) {
      setError((e as Error).message);
      setReady(true);
    }
    return () => {
      active = false;
      cancel();
    };
  }, [onChange]);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = sent
        ? await supabase().auth.verifyOtp({
            email: email.trim(),
            token: code.trim(),
            type: "email",
          })
        : await supabase().auth.signInWithOtp({
            email: email.trim(),
            options: { emailRedirectTo: location.href },
          });
      if (result.error) throw result.error;
      if (!sent) setSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="account-bar" aria-label="Account">
        <nav>
          <a href="/dashboard">My tasks</a> ·{" "}
          <a href="/tasks/new">Create task</a> ·{" "}
          <a href="/settings">Settings & notifications</a>
        </nav>
        {!ready ? (
          <p>Checking session…</p>
        ) : user ? (
          <p>
            Signed in as {user.user.email}{" "}
            <button
              onClick={() =>
                void supabase()
                  .auth.signOut()
                  .catch((e) => setError(e.message))
              }
            >
              Sign out
            </button>
          </p>
        ) : (
          <form onSubmit={login}>
            <label>
              Email{" "}
              <input
                type="email"
                required
                value={email}
                disabled={sent}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {sent && (
              <label>
                Email code{" "}
                <input
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
            )}
            <button disabled={busy}>
              {busy
                ? "Please wait…"
                : sent
                  ? "Verify code"
                  : "Email me a sign-in link / code"}
            </button>
            {sent && (
              <>
                <p>
                  Check your email. Follow the sign-in link, or enter the code
                  if your email includes one.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSent(false);
                    setCode("");
                  }}
                >
                  Use another email / resend
                </button>
              </>
            )}
          </form>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
      {(!required || user) && (
        <Fragment key={user?.user.id || "anonymous"}>{children}</Fragment>
      )}
    </>
  );
}
