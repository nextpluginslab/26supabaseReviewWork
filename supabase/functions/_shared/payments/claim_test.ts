import { handlePayments } from "./handler.ts";
import { sendOneClaimEmail } from "./claim-email.ts";
import { PaymentError } from "./core.ts";
import type { Runtime } from "./runtime.ts";
const id = "20000000-0000-4000-8000-000000000001";
const appUrl = "https://app.example.com";
function assert(value: unknown) {
  if (!value) throw new Error("Assertion failed");
}
function fake(values: Record<string, unknown>) {
  return { appUrl, ...values } as unknown as Runtime;
}
Deno.test("claim requires email proof; knowing a reward id is insufficient", async () => {
  const response = await handlePayments(
    new Request(`${appUrl}/payments/v1/rewards/${id}/claim`),
    fake({
      user: () => {
        throw new PaymentError(401, "unauthenticated", "Verify email");
      },
      claimRpc: () => {
        throw new Error("Must not read without proof");
      },
    }),
  );
  assert(response.status === 401);
});
Deno.test("claim uses verified recipient, denies another user's reward before Stripe", async () => {
  const response = await handlePayments(
    new Request(`${appUrl}/payments/v1/rewards/${id}/claim/onboarding`, {
      method: "POST",
      body: "{}",
    }),
    fake({
      user: () => ({ id: "recipient" }),
      claimRpc: (action: string, actor: string) => {
        assert(action === "reward" && actor === "recipient");
        throw new PaymentError(404, "reward_not_found", "Not found");
      },
    }),
  );
  assert(response.status === 404);
});
Deno.test("claim onboarding returns to the reward page and cannot accept a destination override", async () => {
  let linkCalls = 0;
  const rt = fake({
    user: () => ({ id: "recipient" }),
    claimRpc: () => ({
      id,
      amount_minor: 500,
      state: "pending",
      tester_id: "recipient",
    }),
    rpc: () => ({ id: "connect", account_id: "acct_recipient" }),
    stripe: {
      accountLinks: {
        create: (params: Record<string, string>) => {
          assert(params.account === "acct_recipient");
          assert(
            params.return_url ===
              `${appUrl}/rewards/claim?reward=${id}&connect=return`,
          );
          assert(
            params.refresh_url ===
              `${appUrl}/rewards/claim?reward=${id}&connect=refresh`,
          );
          linkCalls++;
          return { url: "https://connect.stripe.com/setup/test" };
        },
      },
    },
  });
  const call = (body: string) =>
    handlePayments(
      new Request(`${appUrl}/payments/v1/rewards/${id}/claim/onboarding`, {
        method: "POST",
        body,
      }),
      rt,
    );
  assert((await call('{"account":"acct_attacker"}')).status === 422);
  assert(linkCalls === 0);
  assert((await call("{}")).status === 200);
  assert((await call("{}")).status === 200);
  assert(linkCalls === 2);
});
Deno.test("settled rewards do not reopen onboarding", async () => {
  const response = await handlePayments(
    new Request(`${appUrl}/payments/v1/rewards/${id}/claim/onboarding`, {
      method: "POST",
      body: "{}",
    }),
    fake({
      user: () => ({ id: "recipient" }),
      claimRpc: () => ({ id, amount_minor: 500, state: "paid" }),
    }),
  );
  assert(response.status === 409);
});
Deno.test("email failure remains retryable; delivery resolves recipient on server", async () => {
  const actions: string[] = [];
  const rt = fake({
    claimRpc: (action: string) => {
      actions.push(action);
      return action === "claim_email"
        ? { reward_id: id, tester_id: "recipient", lease_id: "lease" }
        : {};
    },
    sendClaimEmail: (recipient: string, reward: string) => {
      assert(recipient === "recipient" && reward === id);
      throw new Error("SMTP offline");
    },
  });
  assert((await sendOneClaimEmail(rt)).sent === false);
  assert(actions.join(",") === "claim_email,email_failed");
});

Deno.test("manual token grants only one reward view without creating an Auth session", async () => {
  const token = "a".repeat(64);
  const rt = fake({
    user: () => {
      throw new Error("Manual claims must not require login");
    },
    linkRpc: (action: string, actor: unknown, data: Record<string, string>) => {
      assert(action === "resolve" && actor === null && data.id === id);
      assert(data.token_hash !== token && data.token_hash.length === 64);
      return {
        id,
        tester_id: "guest",
        state: "pending",
        amount_minor: 500,
        currency: "usd",
      };
    },
    rpc: (action: string, actor: string) => {
      assert(action === "connect" && actor === "guest");
      return { account_id: null };
    },
  });
  const res = await handlePayments(
    new Request(`${appUrl}/payments/v1/rewards/${id}/claim`, {
      headers: { "x-reward-claim": token },
    }),
    rt,
  );
  assert(res.status === 200);
  const body = await res.json();
  assert(body.amount_minor === 500 && !body.tester_id);
  const denied = await handlePayments(
    new Request(`${appUrl}/payments/v1/me/connect-account`, {
      headers: { "x-reward-claim": token },
    }),
    fake({
      user: () => {
        throw new PaymentError(401, "unauthenticated", "Login required");
      },
    }),
  );
  assert(denied.status === 401);
});

Deno.test("publisher-issued link cannot reopen an established recipient account", async () => {
  const rt = fake({
    linkRpc: () => ({
      id,
      tester_id: "recipient",
      state: "pending",
      amount_minor: 500,
    }),
    rpc: () => ({ account_id: "acct_existing" }),
    stripe: {
      accounts: {
        retrieve: () => ({
          id: "acct_existing",
          metadata: { user_id: "recipient" },
          capabilities: { transfers: "active" },
          details_submitted: true,
        }),
      },
    },
  });
  const res = await handlePayments(
    new Request(`${appUrl}/payments/v1/rewards/${id}/claim/onboarding`, {
      method: "POST",
      body: "{}",
      headers: { "x-reward-claim": "a".repeat(64) },
    }),
    rt,
  );
  assert(res.status === 409);
});
