import { failure, runtime } from "../_shared/payments/runtime.ts";
import { handleWebhook } from "../_shared/payments/webhook-handler.ts";

Deno.serve(async (request) => {
  try {
    return await handleWebhook(request, runtime());
  } catch (error) {
    return failure(error);
  }
});
