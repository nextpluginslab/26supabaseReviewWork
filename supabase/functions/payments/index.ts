import { handlePayments } from "../_shared/payments/handler.ts";
import { failure, runtime } from "../_shared/payments/runtime.ts";

Deno.serve(async (request) => {
  if (
    !Deno.env.get("STRIPE_SECRET_KEY") || !Deno.env.get("PAYMENT_MODE") ||
    !Deno.env.get("APP_URL")
  ) {
    return new Response(
      request.method === "OPTIONS" ? null : JSON.stringify({
        code: "payments_not_configured",
        message:
          "Stripe Sandbox payments are not configured yet. Free tasks remain available.",
      }),
      {
        status: request.method === "OPTIONS" ? 204 : 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "authorization, apikey, content-type, idempotency-key, x-client-info",
        },
      },
    );
  }
  try {
    return await handlePayments(request, runtime());
  } catch (error) {
    return failure(error);
  }
});
