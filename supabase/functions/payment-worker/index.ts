import { digest, failure, json, runtime } from "../_shared/payments/runtime.ts";
import { workOne } from "../_shared/payments/service.ts";

import { sendOneClaimEmail } from "../_shared/payments/claim-email.ts";

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") {
      return json({ code: "method_not_allowed" }, 405);
    }
    const rt = runtime();
    const supplied =
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (
      await digest(supplied) !== await digest(rt.env("PAYMENT_WORKER_SECRET"))
    ) {
      return json({ code: "unauthenticated" }, 401);
    }
    // One leased job per invocation bounds execution time. Schedule every minute
    // via Cron, or invoke after the decision transaction commits.
    // Delivery failure must not block an already authorized transfer.
    const email = await sendOneClaimEmail(rt).catch(() => ({
      processed: false,
      error: "email_queue_unavailable",
    }));
    return json({ ...await workOne(rt), email });
  } catch (error) {
    return failure(error);
  }
});
