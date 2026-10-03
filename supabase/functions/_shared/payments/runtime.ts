import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { applicationUrl, PaymentError, requireTestMode } from "./core.ts";

function env(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export function runtime() {
  const key = env("STRIPE_SECRET_KEY");
  requireTestMode(key, env("PAYMENT_MODE"));
  const appUrl = applicationUrl(env("APP_URL"));
  const db = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const stripe = new Stripe(key, {
    apiVersion: "2025-08-27.basil",
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 0,
    timeout: 15000,
  });
  async function rpc<T = Record<string, unknown>>(
    action: string,
    actor: string | null,
    data: Record<string, unknown> = {},
  ): Promise<T> {
    const { data: result, error } = await db.rpc("payments_command", {
      p_action: action,
      p_actor: actor,
      p_data: data,
    });
    if (error) {
      const status = error.code === "42501"
        ? 403
        : error.code === "P0002"
        ? 404
        : ["P0001", "23505", "23514", "22P02"].includes(error.code)
        ? 409
        : 500;
      throw new PaymentError(
        status,
        status === 500 ? "database_error" : "payment_conflict",
        status === 500
          ? "Payment storage is temporarily unavailable."
          : error.message,
      );
    }
    return result as T;
  }
  async function user(request: Request) {
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)
      ?.[1];
    if (!token) {
      throw new PaymentError(401, "unauthenticated", "Sign in to continue.");
    }
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user?.email_confirmed_at) {
      throw new PaymentError(
        401,
        "unauthenticated",
        "A verified user session is required.",
      );
    }
    // A valid Supabase user alone is insufficient: require an interactive session claim.
    let claims: Record<string, unknown>;
    try {
      const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      claims = JSON.parse(
        atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
      );
    } catch {
      throw new PaymentError(401, "unauthenticated", "Invalid session.");
    }
    if (
      claims.role !== "authenticated" ||
      typeof claims.session_id !== "string" || data.user.is_anonymous
    ) {
      throw new PaymentError(
        403,
        "interactive_session_required",
        "Use an interactive user session.",
      );
    }
    return data.user;
  }
  return { stripe, rpc, user, appUrl, env };
}
export type Runtime = ReturnType<typeof runtime>;
export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
export function failure(error: unknown) {
  const id = crypto.randomUUID();
  const known = error instanceof PaymentError;
  console.error(
    JSON.stringify({
      request_id: id,
      code: known ? error.code : "internal_error",
    }),
  );
  return json({
    code: known ? error.code : "internal_error",
    message: known
      ? error.message
      : "Payment service is temporarily unavailable.",
    request_id: id,
  }, known ? error.status : 500);
}
export async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
