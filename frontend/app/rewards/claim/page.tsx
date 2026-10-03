"use client";

import { useEffect, useState } from "react";
import { request } from "@/lib/api-client";
import { session, supabase } from "@/lib/supabase";
import "./reward.css";

type Reward = {
  id: string;
  amount_minor: number;
  currency: string;
  state: string;
  ready: boolean;
};

export default function ClaimReward() {
  const [rewardId, setRewardId] = useState("");
  const [reward, setReward] = useState<Reward | null>(null);
  const [verify, setVerify] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  async function load(id: string) {
    if (!await session()) {
      setVerify(true);
      return;
    }
    try {
      setReward(await request<Reward>("payments", `/rewards/${id}/claim`));
      setVerify(false);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 404) setVerify(true);
      throw e;
    }
  }

  useEffect(() => {
    const id = new URLSearchParams(location.search).get("reward") || "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      setError("Open the reward link from your email to continue.");
      setBusy(false);
      return;
    }
    setRewardId(id);
    // Supabase consumes the email link and establishes proof of ownership.
    // No AuthPanel or separate login screen is part of the claim flow.
    void load(id).catch((e) => setError(e.message)).finally(() =>
      setBusy(false)
    );
  }, []);

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

  async function verifyEmail(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const result = sent
        ? await supabase().auth.verifyOtp({
          email: email.trim(),
          token: code.trim(),
          type: "email",
        })
        : await supabase().auth.signInWithOtp({
          email: email.trim(),
          options: {
            shouldCreateUser: true,
            emailRedirectTo:
              `${location.origin}/rewards/claim?reward=${rewardId}`,
          },
        });
      if (result.error) throw result.error;
      if (sent) await load(rewardId);
      else setSent(true);
    });
  }

  async function setup() {
    const result = await request<{ url: string }>(
      "payments",
      `/rewards/${rewardId}/claim/onboarding`,
      {
        method: "POST",
        body: {},
      },
    );
    const url = new URL(result.url);
    if (url.protocol !== "https:" || url.hostname !== "connect.stripe.com") {
      throw new Error("Invalid receiving account link. Please try again.");
    }
    location.assign(url.href);
  }

  return (
    <main className="reward-claim">
      <a className="reward-brand" href="/">reviewWork</a>
      <section aria-labelledby="reward-title">
        <p className="reward-eyebrow">YOUR FEEDBACK REWARD</p>
        <h1 id="reward-title">Claim your reward</h1>
        <p>
          No password or separate login needed. Your email link verifies that
          the reward belongs to you.
        </p>
        <p className="reward-sandbox">
          Stripe Sandbox · Test funds only · No bank payout
        </p>
        {busy && <p role="status">Please wait…</p>}
        {error && <p role="alert">{error}</p>}
        {verify && (
          <form onSubmit={verifyEmail}>
            <h2>Verify your email</h2>
            <p>
              If your link has expired or was already used, request a new link
              using the email you submitted feedback with.
            </p>
            <label>
              Email address<input
                required
                type="email"
                autoComplete="email"
                value={email}
                disabled={busy || sent}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {sent && (
              <>
                <p role="status">
                  Check your email. Open the secure link, or enter the code
                  here.
                </p>
                <label>
                  Email code<input
                    required
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
              </>
            )}
            <button disabled={busy} type="submit">
              {sent ? "Verify & continue" : "Send secure link"}
            </button>
            {sent && (
              <button
                disabled={busy}
                type="button"
                className="secondary"
                onClick={() => {
                  setSent(false);
                  setCode("");
                }}
              >
                Use another email / resend
              </button>
            )}
          </form>
        )}
        {reward && !verify && (
          <>
            <div className="reward-amount">
              {new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: reward.currency,
              }).format(reward.amount_minor / 100)}
            </div>
            {reward.state === "paid"
              ? (
                <>
                  <h2>Test payment completed</h2>
                  <p>
                    Your reward was transferred to your Stripe test receiving
                    account. There is nothing else to claim.
                  </p>
                </>
              )
              : reward.amount_minor === 0
              ? <p>This feedback does not require a payment.</p>
              : (
                <>
                  <h2>
                    {reward.ready
                      ? "Receiving account ready"
                      : "Set up your receiving account"}
                  </h2>
                  <p>
                    {reward.ready
                      ? "Your feedback has been accepted. The payment status below updates after the transfer is verified."
                      : "Continue to Stripe to provide your receiving details and complete any required identity verification. Then return here to check your reward."}
                  </p>
                  {!reward.ready && (
                    <button
                      disabled={busy}
                      onClick={() => void run(setup)}
                    >
                      Continue to Stripe
                    </button>
                  )}
                  <p>
                    Payment status: <strong>{reward.state}</strong>
                  </p>
                  {reward.state === "failed" && (
                    <p>
                      Your feedback is still accepted. The publisher needs to
                      retry the payment.
                    </p>
                  )}
                  {(reward.state === "unknown" ||
                    reward.state === "reconciliation_required") && (
                    <p>
                      The payment is being reconciled. It has not yet been
                      confirmed as paid.
                    </p>
                  )}
                </>
              )}
          </>
        )}
        {rewardId && !verify && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void run(() => load(rewardId))}
          >
            Refresh payment status
          </button>
        )}
      </section>
    </main>
  );
}
