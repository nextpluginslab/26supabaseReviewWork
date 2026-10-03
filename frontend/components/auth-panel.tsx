"use client";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
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
  const pathname = usePathname();
  const [user, setUser] = useState<Session | null>(null),
    [ready, setReady] = useState(false),
    [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [password, setPassword] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const isTestAccount = email.trim().toLowerCase() === "test@test.com";
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
      if (isTestAccount) {
        const { error } = await supabase().auth.signInWithPassword({
          email: "test@test.com",
          password,
        });
        if (error) throw error;
        setPassword("");
        return;
      }
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
      <header className="account-header">
        <a className="account-brand" href="/">
          reviewWork
        </a>
        {user && (
          <>
            <nav aria-label="Main navigation">
              {[
                ["/dashboard", "My tasks"],
                ["/tasks/new", "Create task"],
                ["/funding", "Funding"],
                ["/settings", "Settings & notifications"],
              ].map(([href, label]) => (
                <a
                  key={href}
                  href={href}
                  aria-current={pathname === href ? "page" : undefined}
                >
                  {label}
                </a>
              ))}
            </nav>
            <div className="account-user">
              <span title={user.user.email}>{user.user.email}</span>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const { error } = await supabase().auth.signOut();
                    if (error) throw error;
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </header>
      {!ready ? (
        <p className="account-loading" role="status">
          Checking session…
        </p>
      ) : !user ? (
        <section className="account-login" aria-labelledby="account-title">
          <h1 id="account-title">Sign in to reviewWork</h1>
          <p>
            {required
              ? "Manage your tasks and feedback."
              : "Sign in to submit your review."}
          </p>
          <form onSubmit={login}>
            <label htmlFor="account-email">Email</label>
            <input
              id="account-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              value={email}
              disabled={sent || busy}
              onChange={(e) => {
                setEmail(e.target.value);
                setPassword("");
                setError("");
              }}
            />
            {isTestAccount && (
              <>
                <label htmlFor="account-password">Test account password</label>
                <input
                  id="account-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </>
            )}
            {sent && (
              <>
                <p role="status">
                  Check your email. Follow the sign-in link, or enter the code
                  if your email includes one.
                </p>
                <label htmlFor="account-code">Email code</label>
                <input
                  id="account-code"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  disabled={busy}
                  onChange={(e) => setCode(e.target.value)}
                />
              </>
            )}
            <button className="account-primary" disabled={busy}>
              {busy
                ? "Please wait…"
                : isTestAccount
                  ? "Sign in"
                  : sent
                    ? "Verify code"
                    : "Email me a sign-in link / code"}
            </button>
            {sent && (
              <button
                className="account-secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setSent(false);
                  setCode("");
                  setError("");
                }}
              >
                Use another email / resend
              </button>
            )}
          </form>
          {error && (
            <p className="account-error" role="alert">
              {error}
            </p>
          )}
        </section>
      ) : error ? (
        <p className="account-error account-feedback" role="alert">
          {error}
        </p>
      ) : null}
      {(!required || user) && (
        <Fragment key={user?.user.id || "anonymous"}>{children}</Fragment>
      )}
    </>
  );
}
