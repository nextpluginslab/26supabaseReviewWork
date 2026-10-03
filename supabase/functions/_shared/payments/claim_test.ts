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
