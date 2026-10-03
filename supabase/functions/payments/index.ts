import { handlePayments } from "../_shared/payments/handler.ts";
import { failure, runtime } from "../_shared/payments/runtime.ts";

Deno.serve(async (request) => {
  try {
    return await handlePayments(request, runtime());
  } catch (error) {
    return failure(error);
  }
});
