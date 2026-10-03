import Stripe from "stripe";
import {
  assertTest,
  type Attempt,
  canReplay,
  checkoutParams,
  type Funding,
  PaymentError,
  requireTestMode,
  verifySession,
  verifyTransfer,
} from "./core.ts";
import { handlePayments } from "./handler.ts";
import { type Runtime } from "./runtime.ts";
import { createFunding, syncFunding, webhook, workOne } from "./service.ts";
import { handleWebhook } from "./webhook-handler.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function throws(fn: () => unknown) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error("Expected an exception");
}
async function rejects(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("Expected a rejection");
}
const task = "20000000-0000-4000-8000-000000000001";
const actor = "10000000-0000-4000-8000-000000000001";
const f: Funding = {
  id: "funding-1",
  task_id: task,
  publisher_id: actor,
  amount_minor: 2000,
  session_id: null,
  state: "creating",
  created_at: new Date().toISOString(),
};
const session = {
  id: "cs_test_1",
  livemode: false,
  mode: "payment",
  amount_total: 2000,
  currency: "usd",
  metadata: { funding_id: f.id, task_id: task, application: "reviewwork" },
  client_reference_id: task,
  payment_status: "unpaid",
  status: "open",
  url: "https://checkout.stripe.com/demo",
} as unknown as Stripe.Checkout.Session;
const a: Attempt = {
  id: "attempt-1",
  reward_id: "reward-1",
  task_id: task,
  tester_id: actor,
  amount_minor: 200,
  destination: "acct_1",
  source_charge: "ch_1",
  transfer_id: null,
  created_at: new Date().toISOString(),
};
const transfer = {
  id: "tr_1",
  livemode: false,
  amount: 200,
  currency: "usd",
  destination: "acct_1",
  source_transaction: "ch_1",
  transfer_group: `task_${task}`,
  metadata: { attempt_id: a.id, reward_id: a.reward_id },
  reversed: false,
  amount_reversed: 0,
} as unknown as Stripe.Transfer;
const appUrl = "https://app.example.com";
function fake(values: Record<string, unknown>): Runtime {
  return { appUrl, ...values } as unknown as Runtime;
}

Deno.test("only test secrets and explicitly test objects are accepted", () => {
  requireTestMode("sk_test_fake", "stripe_test");
  throws(() => requireTestMode("sk_live_fake", "stripe_test"));
  throws(() => requireTestMode("sk_test_fake", "live"));
  throws(() => assertTest({ livemode: true }));
  throws(() => assertTest({}));
});
Deno.test("Checkout uses the frozen budget, one-time USD payment and trusted return URL", () => {
  const p = checkoutParams(f, appUrl);
  equal(p.mode, "payment");
  equal(p.line_items?.[0].price_data?.unit_amount, 2000);
  equal(p.line_items?.[0].price_data?.currency, "usd");
  equal(p.payment_intent_data?.transfer_group, `task_${task}`);
  equal(p.success_url, `${appUrl}/tasks/${task}/results?funding=return`);
});
Deno.test("Checkout verification rejects another task, amount, currency, mode or session", () => {
  verifySession(f, session);
  for (
    const patch of [
      { amount_total: 1 },
      { currency: "eur" },
      { livemode: true },
      { mode: "subscription" },
      { client_reference_id: "other" },
      { metadata: { funding_id: "other" } },
    ]
  ) {
    throws(() =>
      verifySession(f, { ...session, ...patch } as Stripe.Checkout.Session)
    );
  }
  throws(() => verifySession({ ...f, session_id: "cs_other" }, session));
});
Deno.test("transfer verification checks reward, recipient, amount and source charge", () => {
  verifyTransfer(a, transfer);
  for (
    const patch of [
      { amount: 201 },
      { destination: "acct_other" },
      { source_transaction: "ch_other" },
      { currency: "eur" },
      { livemode: true },
      { metadata: { attempt_id: "other" } },
    ]
  ) {
    throws(() =>
      verifyTransfer(a, { ...transfer, ...patch } as Stripe.Transfer)
    );
  }
});
Deno.test("Stripe idempotency cutoff is bounded below 24 hours", () => {
  const now = Date.now();
  equal(canReplay(new Date(now - 22 * 3600000).toISOString(), now), true);
  equal(canReplay(new Date(now - 24 * 3600000).toISOString(), now), false);
});
Deno.test("lost Checkout response replays the durable funding key", async () => {
  const keys: string[] = [];
  const rt = fake({
    rpc: (action: string) =>
      Promise.resolve(action === "reserve_funding" ? f : f),
    stripe: {
      checkout: {
        sessions: {
          create: (_p: unknown, opts: { idempotencyKey: string }) => {
            keys.push(opts.idempotencyKey);
            return Promise.resolve(session);
          },
        },
      },
    },
  });
  await createFunding(rt, actor, task);
  await createFunding(rt, actor, task);
  equal(keys, [`funding:${f.id}`, `funding:${f.id}`]);
});
Deno.test("unpaid Checkout cannot be recorded as funded", async () => {
  let state = "";
  const rt = fake({
    rpc: (_action: string, _actor: unknown, data: { state: string }) => {
      state = data.state;
      return Promise.resolve(f);
    },
  });
  await syncFunding(rt, f, session);
  equal(state, "open");
});
Deno.test("paid Checkout requires a verified matching successful charge", async () => {
  let writes = 0;
  const rt = fake({
    rpc: () => {
      writes++;
      return Promise.resolve({});
    },
    stripe: {
      paymentIntents: {
        retrieve: () =>
          Promise.resolve({
            id: "pi_1",
            livemode: false,
            status: "succeeded",
            amount: 2000,
            amount_received: 2000,
            currency: "usd",
            metadata: { funding_id: f.id, task_id: task },
            latest_charge: {
              id: "ch_1",
              livemode: false,
              paid: true,
              captured: true,
              refunded: false,
              amount_refunded: 0,
              disputed: false,
              amount: 1,
              currency: "usd",
              payment_intent: "pi_1",
            },
          }),
      },
    },
  });
  await rejects(() =>
    syncFunding(rt, f, {
      ...session,
      payment_status: "paid",
      payment_intent: "pi_1",
    })
  );
  equal(writes, 0);
});
Deno.test("unknown transfer found during reconciliation is settled without a second POST", async () => {
  let creates = 0;
  const actions: string[] = [];
  const rt = fake({
    rpc: (action: string) => {
      actions.push(action);
      return Promise.resolve(
        action === "claim"
          ? { id: a.reward_id, tester_id: actor }
          : action === "current_attempt"
          ? a
          : {},
      );
    },
    stripe: {
      transfers: {
        list: () => Promise.resolve({ data: [transfer], has_more: false }),
        create: () => {
          creates++;
        },
      },
    },
  });
  equal((await workOne(rt)).state, "paid");
  equal(creates, 0);
  equal(actions.includes("finish_attempt"), true);
});
Deno.test("ambiguous timeout preserves the same attempt for retry", async () => {
  let state = "";
  let key = "";
  const rt = fake({
    rpc: (action: string, _actor: unknown, data: Record<string, unknown>) => {
      if (action === "finish_attempt") state = data.state as string;
      return Promise.resolve(
        action === "claim"
          ? { id: a.reward_id, tester_id: actor }
          : action === "current_attempt"
          ? a
          : {},
      );
    },
    stripe: {
      accounts: {
        retrieve: () =>
          Promise.resolve({
            metadata: { user_id: actor },
            capabilities: { transfers: "active" },
          }),
      },
      transfers: {
        list: () => Promise.resolve({ data: [], has_more: false }),
        create: (_p: unknown, opts: { idempotencyKey: string }) => {
          key = opts.idempotencyKey;
          throw new Error("connection dropped after write");
        },
      },
    },
  });
  await workOne(rt);
  equal(state, "unknown");
  equal(key, `transfer:${a.id}`);
});
Deno.test("expired ambiguous attempt blocks a new transfer", async () => {
  let state = "";
  let creates = 0;
  const rt = fake({
    rpc: (action: string, _actor: unknown, data: Record<string, unknown>) => {
      if (action === "defer") state = data.state as string;
      return Promise.resolve(
        action === "claim"
          ? { id: a.reward_id, tester_id: actor }
          : action === "current_attempt"
          ? { ...a, created_at: "2020-01-01T00:00:00Z" }
          : {},
      );
    },
    stripe: {
      transfers: {
        list: () => Promise.resolve({ data: [], has_more: false }),
        create: () => {
          creates++;
        },
      },
    },
  });
  await workOne(rt);
  equal(creates, 0);
  equal(state, "reconciliation_required");
});
Deno.test("Connect not ready does not start Stripe's replay window", async () => {
  const actions: string[] = [];
  const rt = fake({
    rpc: (action: string) => {
      actions.push(action);
      return Promise.resolve(
        action === "claim"
          ? { id: a.reward_id, tester_id: actor }
          : action === "current_attempt"
          ? null
          : { account_id: null },
      );
    },
  });
  equal((await workOne(rt)).state, "pending");
  equal(actions.includes("prepare_attempt"), false);
});
Deno.test("payment API rejects unauthenticated requests, forged amounts and untrusted origins", async () => {
  const url =
    `${appUrl}/functions/v1/payments/v1/tasks/${task}/funding-sessions`;
  const unauth = fake({
    user: () => {
      throw new PaymentError(401, "unauthenticated", "Sign in");
    },
  });
  equal(
    (await handlePayments(new Request(url, { method: "POST" }), unauth)).status,
    401,
  );
  const rt = fake({ user: () => Promise.resolve({ id: actor }) });
  equal(
    (await handlePayments(
      new Request(url, {
        method: "POST",
        headers: { "idempotency-key": "k" },
        body: '{"amount":1}',
      }),
      rt,
    )).status,
    422,
  );
  equal(
    (await handlePayments(
      new Request(url, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
      rt,
    )).status,
    403,
  );
  equal(
    (await handlePayments(new Request(url, { method: "POST" }), rt)).status,
    422,
  );
});
Deno.test("cached retry response does not execute another mutation", async () => {
  const actions: string[] = [];
  const rt = fake({
    user: () => Promise.resolve({ id: actor }),
    rpc: (action: string) => {
      actions.push(action);
      return Promise.resolve({ cached: true, response: { state: "pending" } });
    },
  });
  const req = new Request(`${appUrl}/payments/v1/rewards/${task}/retry`, {
    method: "POST",
    headers: { "idempotency-key": "k" },
  });
  equal((await handlePayments(req, rt)).status, 202);
  equal(actions, ["request_begin"]);
});
Deno.test("webhook ignores unrelated applications and rejects live events", async () => {
  let calls = 0;
  const rt = fake({
    rpc: () => {
      calls++;
      throw new Error("must not access unrelated data");
    },
  });
  const e = {
    livemode: false,
    type: "checkout.session.completed",
    data: { object: { metadata: {} } },
  } as Stripe.Event;
  equal((await webhook(rt, e)).ignored, true);
  equal(calls, 0);
  await rejects(() => webhook(rt, { ...e, livemode: true }));
});
Deno.test("webhook verifies real SDK signatures, rejects altered bodies and stale timestamps", async () => {
  const stripe = new Stripe("sk_test_fake", {
    httpClient: Stripe.createFetchHttpClient(),
  });
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({
    id: "evt_test",
    type: "unrelated.event",
    livemode: false,
    data: { object: {} },
  });
  const rt = fake({ stripe, env: () => secret });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    timestamp,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  const request = (body: string, sig = signature) =>
    new Request(`${appUrl}/stripe-webhook`, {
      method: "POST",
      body,
      headers: { "stripe-signature": sig },
    });
  equal((await handleWebhook(request(payload), rt)).status, 200);
  equal((await handleWebhook(request(payload + " "), rt)).status, 400);
  const stale = await stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    timestamp: timestamp - 600,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  equal((await handleWebhook(request(payload, stale), rt)).status, 400);
});

Deno.test("a new authorized transfer uses the frozen destination and source charge", async () => {
  let params: Record<string, unknown> = {};
  let paid = false;
  const rt = fake({
    rpc: (action: string, _actor: unknown, data: Record<string, unknown>) => {
      if (action === "finish_attempt") paid = data.state === "paid";
      return Promise.resolve(
        action === "claim"
          ? { id: a.reward_id, tester_id: actor }
          : action === "current_attempt"
          ? a
          : {},
      );
    },
    stripe: {
      accounts: {
        retrieve: () =>
          Promise.resolve({
            metadata: { user_id: actor },
            capabilities: { transfers: "active" },
          }),
      },
      transfers: {
        list: () => Promise.resolve({ data: [], has_more: false }),
        create: (value: Record<string, unknown>) => {
          params = value;
          return Promise.resolve(transfer);
        },
      },
    },
  });
  equal((await workOne(rt)).state, "paid");
  equal(params.amount, a.amount_minor);
  equal(params.destination, a.destination);
  equal(params.source_transaction, a.source_charge);
  equal(paid, true);
});

Deno.test("a delayed expired webhook uses the current paid Session and verifies its Charge", async () => {
  let recorded: Record<string, unknown> = {};
  const rt = fake({
    rpc: (action: string, _actor: unknown, data: Record<string, unknown>) => {
      if (action === "apply_funding") recorded = data;
      return Promise.resolve(f);
    },
    stripe: {
      checkout: {
        sessions: {
          retrieve: () =>
            Promise.resolve({
              ...session,
              status: "complete",
              payment_status: "paid",
              payment_intent: "pi_1",
            }),
        },
      },
      paymentIntents: {
        retrieve: () =>
          Promise.resolve({
            id: "pi_1",
            livemode: false,
            status: "succeeded",
            amount: 2000,
            amount_received: 2000,
            currency: "usd",
            metadata: { funding_id: f.id, task_id: task },
            latest_charge: {
              id: "ch_1",
              livemode: false,
              paid: true,
              captured: true,
              refunded: false,
              amount_refunded: 0,
              disputed: false,
              amount: 2000,
              currency: "usd",
              payment_intent: "pi_1",
            },
          }),
      },
    },
  });
  await webhook(
    rt,
    {
      id: "evt_delayed",
      livemode: false,
      type: "checkout.session.expired",
      data: { object: { ...session, status: "expired" } },
    } as unknown as Stripe.Event,
  );
  equal(recorded.state, "paid");
  equal(recorded.charge_id, "ch_1");
  equal(recorded.event_id, "evt_delayed");
});
