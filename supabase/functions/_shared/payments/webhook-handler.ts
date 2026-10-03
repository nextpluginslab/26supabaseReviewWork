import Stripe from "stripe";
import { PaymentError } from "./core.ts";
import { failure, json, type Runtime } from "./runtime.ts";
import { webhook } from "./service.ts";

export async function handleWebhook(request: Request, rt: Runtime) {
  try {
    if (request.method !== "POST") {
      return json({ code: "method_not_allowed" }, 405);
    }
    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      throw new PaymentError(
        400,
        "invalid_signature",
        "Stripe signature required.",
      );
    }
    const secret = rt.env("STRIPE_WEBHOOK_SECRET");
    // Verification must receive the exact raw body, before JSON parsing.
    const body = await request.text();
    let event: Stripe.Event;
    try {
      event = await rt.stripe.webhooks.constructEventAsync(
        body,
        signature,
        secret,
        300,
        Stripe.createSubtleCryptoProvider(),
      );
    } catch {
      throw new PaymentError(
        400,
        "invalid_signature",
        "Invalid Stripe signature.",
      );
    }
    return json(await webhook(rt, event));
  } catch (error) {
    return failure(error);
  }
}
