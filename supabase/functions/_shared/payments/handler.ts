import { PaymentError, uuid } from "./core.ts";
import { digest, failure, json, type Runtime } from "./runtime.ts";
import {
  connectStatus,
  createFunding,
  onboarding,
  taskPayments,
} from "./service.ts";

export async function handlePayments(
  request: Request,
  rt: Runtime,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== rt.appUrl) {
    return json({ code: "origin_not_allowed" }, 403);
  }
  const headers = {
    "access-control-allow-origin": rt.appUrl,
    "access-control-allow-headers":
      "authorization, apikey, content-type, idempotency-key, x-client-info",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "vary": "Origin",
  };
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  let response: Response;
  try {
    const user = await rt.user(request);
    const path = new URL(request.url).pathname.replace(
      /^\/(?:functions\/v1\/)?payments/,
      "",
    );
    const task = path.match(
      /^\/v1\/tasks\/([^/]+)\/(funding-sessions|funding|budget)$/,
    );
    const retry = path.match(/^\/v1\/rewards\/([^/]+)\/retry$/);
    if (request.method === "GET" && task && task[2] !== "funding-sessions") {
      response = json(await taskPayments(rt, user.id, uuid(task[1])));
    } else if (request.method === "GET" && path === "/v1/me/connect-account") {
      response = json(await connectStatus(rt, user.id));
    } else if (
      request.method === "POST" &&
      (task?.[2] === "funding-sessions" || retry ||
        path === "/v1/me/connect-onboarding")
    ) {
      if (task) uuid(task[1]);
      if (retry) uuid(retry[1]);
      const key = request.headers.get("idempotency-key");
      if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) {
        throw new PaymentError(
          422,
          "idempotency_key_required",
          "Provide an Idempotency-Key (1–128 letters, digits, _, ., :, -).",
        );
      }
      const text = await request.text();
      if (text.length > 1024) {
        throw new PaymentError(
          413,
          "body_too_large",
          "Request body is too large.",
        );
      }
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new PaymentError(422, "invalid_json", "Expected a JSON object.");
      }
      if (
        !body || Array.isArray(body) || typeof body !== "object" ||
        Object.keys(body).length
      ) {
        throw new PaymentError(
          422,
          "unexpected_fields",
          "This endpoint accepts an empty object; amounts and ownership come from the server.",
        );
      }
      const route = `POST ${path}`;
      const record = await rt.rpc<{ cached: boolean; response?: unknown }>(
        "request_begin",
        user.id,
        { route, key, hash: await digest("{}") },
      );
      let result = record.response;
      if (!record.cached) {
        if (task) result = await createFunding(rt, user.id, task[1]);
        else if (retry) {
          const reward = await rt.rpc<{ id: string; state: string }>(
            "retry",
            user.id,
            { id: retry[1], request_key: key },
          );
          result = {
            reward_id: reward.id,
            state: reward.state,
            mode: "stripe_test",
          };
        } else result = await onboarding(rt, user.id, await digest(key));
        await rt.rpc("request_finish", user.id, {
          route,
          key,
          response: result,
        });
      }
      response = json(result, retry ? 202 : 200);
    } else {response = json({
        code: "not_found",
        message: "Payment route not found.",
      }, 404);}
  } catch (error) {
    response = failure(error);
  }
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}
