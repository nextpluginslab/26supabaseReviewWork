import Stripe from "npm:stripe@18.5.0";
import {
  assertTest,
  type Attempt,
  canReplay,
  checkoutParams,
  type Funding,
  objectId,
  PaymentError,
  safeFailure,
  verifySession,
  verifyTransfer,
} from "./core.ts";
import type { Runtime } from "./runtime.ts";

type Connect = { id: string; account_id: string | null; created_at: string };
type Reward = { id: string; tester_id: string; state: string };
type EventRef = { event_id?: string; event_type?: string };

export async function syncFunding(
  rt: Runtime,
  f: Funding,
  session: Stripe.Checkout.Session,
  event: EventRef = {},
) {
  verifySession(f, session);
  let chargeId: string | null = null;
  let state = session.status === "expired" ? "expired" : "open";
  if (session.payment_status === "paid") {
    const piId = objectId(session.payment_intent);
    if (!piId) {
      throw new PaymentError(
        409,
        "missing_payment",
        "PaymentIntent is missing.",
      );
    }
    const pi = await rt.stripe.paymentIntents.retrieve(piId, {
      expand: ["latest_charge"],
    });
    assertTest(pi);
    const charge = pi.latest_charge;
    if (
      pi.status !== "succeeded" || pi.amount !== f.amount_minor ||
      pi.amount_received !== f.amount_minor ||
      pi.currency !== "usd" || pi.metadata.funding_id !== f.id ||
      pi.metadata.task_id !== f.task_id ||
      !charge || typeof charge === "string"
    ) {
      throw new PaymentError(
        409,
        "funding_mismatch",
        "Funding payment could not be verified.",
      );
    }
    assertTest(charge);
    if (
      !charge.paid || !charge.captured || charge.refunded ||
      charge.amount_refunded !== 0 ||
      charge.disputed || charge.amount !== f.amount_minor ||
      charge.currency !== "usd" ||
      objectId(charge.payment_intent) !== pi.id
    ) {
      throw new PaymentError(
        409,
        "funding_mismatch",
        "Funding charge could not be verified.",
      );
    }
    chargeId = charge.id;
    state = "paid";
  }
  return await rt.rpc<Funding>("apply_funding", null, {
    id: f.id,
    session_id: session.id,
    state,
    charge_id: chargeId,
    ...event,
  });
}
export async function createFunding(
  rt: Runtime,
  actor: string,
  taskId: string,
) {
  let f = await rt.rpc<Funding>("reserve_funding", actor, { task_id: taskId });
  if (f.session_id) {
    const session = await rt.stripe.checkout.sessions.retrieve(f.session_id);
    f = await syncFunding(rt, f, session);
    if (f.state !== "expired") {
      return { session_id: session.id, url: session.url, state: f.state };
    }
    f = await rt.rpc<Funding>("reserve_funding", actor, { task_id: taskId });
  }
  if (!canReplay(f.created_at)) {
    throw new PaymentError(
      409,
      "reconciliation_required",
      "Reconcile the previous Checkout creation before trying again.",
    );
  }
  const session = await rt.stripe.checkout.sessions.create(
    checkoutParams(f, rt.appUrl),
    {
      idempotencyKey: `funding:${f.id}`,
    },
  );
  await syncFunding(rt, f, session);
  return { session_id: session.id, url: session.url, state: session.status };
}
export async function taskPayments(rt: Runtime, actor: string, taskId: string) {
  let task = await rt.rpc<
    { funding: Funding | null } & Record<string, unknown>
  >("task", actor, { task_id: taskId });
  if (task.funding?.session_id && task.funding.state !== "paid") {
    await syncFunding(
      rt,
      task.funding,
      await rt.stripe.checkout.sessions.retrieve(task.funding.session_id),
    );
    task = await rt.rpc("task", actor, { task_id: taskId });
  }
  const { funding, charge_id: _charge, ...safe } = task;
  return {
    ...safe,
    mode: "stripe_test",
    funding: funding
      ? { state: funding.state, session_id: funding.session_id }
      : null,
  };
}
export async function connectStatus(rt: Runtime, actor: string) {
  const c = await rt.rpc<Connect>("connect", actor);
  if (!c.account_id) {
    return { account_id: null, ready: false, mode: "stripe_test" };
  }
  const account = await rt.stripe.accounts.retrieve(c.account_id);
  if (account.metadata?.user_id !== actor) {
    throw new PaymentError(
      409,
      "account_mismatch",
      "Connect account ownership mismatch.",
    );
  }
  return {
    account_id: account.id,
    ready: account.capabilities?.transfers === "active",
    details_submitted: account.details_submitted,
    currently_due: account.requirements?.currently_due ?? [],
    mode: "stripe_test",
  };
}
export async function onboarding(
  rt: Runtime,
  actor: string,
  requestKey: string,
  claimRewardId?: string,
) {
  let c = await rt.rpc<Connect>("prepare_connect", actor);
  if (!c.account_id) {
    if (!canReplay(c.created_at)) {
      throw new PaymentError(
        409,
        "reconciliation_required",
        "Reconcile Connect account creation before retrying.",
      );
    }
    const account = await rt.stripe.accounts.create({
      type: "express",
      capabilities: { transfers: { requested: true } },
      metadata: { user_id: actor, application: "reviewwork" },
      settings: { payouts: { schedule: { interval: "manual" } } },
    }, { idempotencyKey: `connect:${c.id}` });
    c = await rt.rpc<Connect>("save_connect", actor, {
      account_id: account.id,
    });
  }
  const link = await rt.stripe.accountLinks.create({
    account: c.account_id!,
    type: "account_onboarding",
    refresh_url: claimRewardId
      ? `${rt.appUrl}/rewards/claim?reward=${claimRewardId}&connect=refresh`
      : `${rt.appUrl}/settings?connect=refresh`,
    return_url: claimRewardId
      ? `${rt.appUrl}/rewards/claim?reward=${claimRewardId}&connect=return`
      : `${rt.appUrl}/settings?connect=return`,
  }, { idempotencyKey: `onboarding:${actor}:${requestKey}` });
  return { url: link.url, expires_at: link.expires_at, mode: "stripe_test" };
}

async function existingTransfer(
  rt: Runtime,
  a: Attempt,
): Promise<Stripe.Transfer | null> {
  if (a.transfer_id) return await rt.stripe.transfers.retrieve(a.transfer_id);
  let cursor: string | undefined;
  // Bound worker duration. An incomplete scan must NOT lead to a new transfer.
  for (let page = 0; page < 10; page++) {
    const batch = await rt.stripe.transfers.list({
      transfer_group: `task_${a.task_id}`,
      limit: 100,
      ...(cursor ? { starting_after: cursor } : {}),
    });
    const match = batch.data.find((transfer) =>
      transfer.metadata.attempt_id === a.id
    );
    if (match) return match;
    if (!batch.has_more) return null;
    cursor = batch.data.at(-1)?.id;
  }
  throw new PaymentError(
    409,
    "reconciliation_required",
    "Transfer history requires manual reconciliation.",
  );
}
export async function settleTransfer(
  rt: Runtime,
  a: Attempt,
  transfer: Stripe.Transfer,
  event: EventRef = {},
) {
  verifyTransfer(a, transfer);
  return await rt.rpc("finish_attempt", null, {
    id: a.id,
    state: "paid",
    transfer_id: transfer.id,
    reversed: transfer.reversed || transfer.amount_reversed > 0,
    ...event,
  });
}
export async function workOne(rt: Runtime) {
  const r = await rt.rpc<Reward | null>("claim", null);
  if (!r) return { processed: false };
  let a: Attempt | null = null;
  let posted = false;
  try {
    a = await rt.rpc<Attempt | null>("current_attempt", null, { id: r.id });
    if (!a) {
      const status = await connectStatus(rt, r.tester_id);
      if (!status.ready) {
        await rt.rpc("defer", null, {
          id: r.id,
          state: "pending",
          error_code: "connect_not_ready",
        });
        return { processed: true, state: "pending" };
      }
      a = await rt.rpc<Attempt | null>("prepare_attempt", null, { id: r.id });
    }
    if (!a) {
      await rt.rpc("defer", null, {
        id: r.id,
        state: "pending",
        error_code: "connect_not_ready",
      });
      return { processed: true, state: "pending" };
    }
    let transfer = await existingTransfer(rt, a);
    if (!transfer) {
      if (!canReplay(a.created_at)) {
        throw new PaymentError(
          409,
          "reconciliation_required",
          "Stripe idempotency window elapsed.",
        );
      }
      const account = await rt.stripe.accounts.retrieve(a.destination);
      if (account.metadata?.user_id !== r.tester_id) {
        throw new PaymentError(
          409,
          "account_mismatch",
          "Connect account ownership mismatch.",
        );
      }
      if (account.capabilities?.transfers !== "active") {
        await rt.rpc("defer", null, {
          id: r.id,
          state: "pending",
          error_code: "connect_not_ready",
        });
        return { processed: true, state: "pending" };
      }
      posted = true;
      transfer = await rt.stripe.transfers.create({
        amount: a.amount_minor,
        currency: "usd",
        destination: a.destination,
        source_transaction: a.source_charge,
        transfer_group: `task_${a.task_id}`,
        metadata: {
          reward_id: a.reward_id,
          attempt_id: a.id,
          application: "reviewwork",
        },
      }, { idempotencyKey: `transfer:${a.id}` });
    }
    await settleTransfer(rt, a, transfer);
    return { processed: true, state: "paid" };
  } catch (error) {
    if (
      error instanceof PaymentError &&
      [
        "reconciliation_required",
        "transfer_mismatch",
        "account_mismatch",
        "live_mode_rejected",
      ].includes(error.code)
    ) {
      await rt.rpc("defer", null, {
        id: r.id,
        state: "reconciliation_required",
        error_code: error.code,
      });
    } else if (a) {
      await rt.rpc("finish_attempt", null, {
        id: a.id,
        state: posted ? safeFailure(error) : "unknown",
        error_code: "stripe_request_failed",
      });
    } else {
      await rt.rpc("defer", null, {
        id: r.id,
        state: "pending",
        error_code: "temporarily_unavailable",
      });
    }
    return { processed: true, state: "deferred" };
  }
}
export async function webhook(rt: Runtime, event: Stripe.Event) {
  assertTest(event);
  if (
    [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
    ].includes(event.type)
  ) {
    const object = event.data.object as Stripe.Checkout.Session;
    if (object.metadata?.application !== "reviewwork") {
      return { received: true, ignored: true };
    }
    const f = await rt.rpc<Funding>("funding", null, {
      id: object.metadata.funding_id,
    });
    // Fetch latest Stripe state so delayed events cannot undo a successful payment.
    await syncFunding(
      rt,
      f,
      await rt.stripe.checkout.sessions.retrieve(object.id),
      { event_id: event.id, event_type: event.type },
    );
  } else if (
    ["transfer.created", "transfer.updated", "transfer.reversed"].includes(
      event.type,
    )
  ) {
    const object = event.data.object as Stripe.Transfer;
    if (object.metadata?.application !== "reviewwork") {
      return { received: true, ignored: true };
    }
    const a = await rt.rpc<Attempt>("attempt", null, {
      id: object.metadata.attempt_id,
    });
    await settleTransfer(rt, a, await rt.stripe.transfers.retrieve(object.id), {
      event_id: event.id,
      event_type: event.type,
    });
  }
  // Connect status is retrieved live; no stale account.updated projection to race.
  return { received: true };
}
