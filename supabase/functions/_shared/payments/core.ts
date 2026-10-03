import Stripe from "stripe";

export class PaymentError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export function requireTestMode(key: string, mode: string) {
  if (mode !== "stripe_test" || !key.startsWith("sk_test_")) {
    throw new Error(
      "Payments require PAYMENT_MODE=stripe_test and a Stripe test secret key.",
    );
  }
}
export function assertTest(object: { livemode?: boolean }) {
  if (object.livemode !== false) {
    throw new PaymentError(
      422,
      "live_mode_rejected",
      "Only Stripe test objects are supported.",
    );
  }
}
export function objectId(
  value: string | { id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}
export function uuid(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new PaymentError(422, "invalid_id", "Expected a UUID.");
  }
  return value;
}
export function applicationUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new Error("APP_URL must use HTTPS (or localhost for development).");
  }
  if (
    url.username || url.password || url.search || url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "APP_URL must be an origin without credentials, path, query or fragment.",
    );
  }
  return url.origin;
}
export type Funding = {
  id: string;
  task_id: string;
  publisher_id: string;
  amount_minor: number;
  session_id: string | null;
  state: string;
  created_at: string;
};
export function checkoutParams(
  f: Funding,
  appUrl: string,
): Stripe.Checkout.SessionCreateParams {
  const metadata = {
    funding_id: f.id,
    task_id: f.task_id,
    application: "reviewwork",
  };
  return {
    mode: "payment",
    payment_method_types: ["card"],
    client_reference_id: f.task_id,
    metadata,
    payment_intent_data: { metadata, transfer_group: `task_${f.task_id}` },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: f.amount_minor,
        product_data: { name: "Fieldwork task budget (Sandbox)" },
      },
    }],
    success_url: `${appUrl}/tasks/${f.task_id}/results?funding=return`,
    cancel_url: `${appUrl}/tasks/${f.task_id}/results?funding=cancelled`,
  };
}
export function verifySession(f: Funding, session: Stripe.Checkout.Session) {
  assertTest(session);
  if (
    (f.session_id && f.session_id !== session.id) ||
    session.mode !== "payment" ||
    session.amount_total !== f.amount_minor || session.currency !== "usd" ||
    session.client_reference_id !== f.task_id ||
    session.metadata?.funding_id !== f.id ||
    session.metadata?.task_id !== f.task_id
  ) {
    throw new PaymentError(
      409,
      "funding_mismatch",
      "Checkout does not match the frozen task budget.",
    );
  }
}
export type Attempt = {
  id: string;
  reward_id: string;
  task_id: string;
  tester_id: string;
  amount_minor: number;
  destination: string;
  source_charge: string;
  created_at: string;
  transfer_id: string | null;
};
export function verifyTransfer(a: Attempt, transfer: Stripe.Transfer) {
  assertTest(transfer);
  if (
    transfer.amount !== a.amount_minor || transfer.currency !== "usd" ||
    objectId(transfer.destination) !== a.destination ||
    objectId(transfer.source_transaction) !== a.source_charge ||
    transfer.metadata?.attempt_id !== a.id ||
    transfer.metadata?.reward_id !== a.reward_id ||
    transfer.transfer_group !== `task_${a.task_id}`
  ) {
    throw new PaymentError(
      409,
      "transfer_mismatch",
      "Transfer does not match the authorized reward.",
    );
  }
}
export function canReplay(createdAt: string, now = Date.now()) {
  // Stripe can prune idempotency keys after 24h. Never blindly POST again after that window.
  return now - Date.parse(createdAt) < 23 * 60 * 60 * 1000;
}
export function safeFailure(error: unknown) {
  // Only an explicit invalid request proves that no transfer was created.
  // Timeouts, 5xx, connection failures and idempotency conflicts remain unknown.
  return error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.statusCode === 400 && error.code !== "idempotency_key_in_use"
    ? "failed"
    : "unknown";
}
