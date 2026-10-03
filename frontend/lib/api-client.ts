import { session } from "./supabase";
export type Service =
  | "api"
  | "submissions"
  | "payments"
  | "api-keys"
  | "notifications";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}
export function endpoint(service: Service) {
  const root = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!root) throw new Error("Supabase is not configured.");
  const configured =
    service === "api"
      ? process.env.NEXT_PUBLIC_API_URL
      : service === "payments"
        ? process.env.NEXT_PUBLIC_PAYMENTS_API_URL
        : undefined;
  const base = (configured || `${root}/functions/v1/${service}`).replace(
    /\/$/,
    "",
  );
  return service === "api-keys" || base.endsWith("/v1") ? base : `${base}/v1`;
}
export async function request<T>(
  service: Service,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    public?: boolean;
    key?: string;
  } = {},
): Promise<T> {
  const auth = options.public ? null : await session();
  if (!options.public && !auth)
    throw new ApiError(401, "unauthenticated", "Sign in to continue.");
  const headers: Record<string, string> = {
    apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  };
  if (auth) headers.Authorization = `Bearer ${auth.access_token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.key) headers["Idempotency-Key"] = options.key;
  const response = await fetch(endpoint(service) + path, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = data.error || data;
    throw new ApiError(
      response.status,
      e.code || "request_failed",
      e.message || e.code || `Request failed (${response.status})`,
      e.field_errors,
    );
  }
  return data;
}
// Keep the key after a timeout/unknown response; clear only after confirmed success.
export async function mutate<T>(
  service: Service,
  path: string,
  body: unknown,
  method = "POST",
): Promise<T> {
  const auth = await session();
  if (!auth) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
  const fingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(body)),
      ),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const storageKey = `reviewwork:request:${auth.user.id}:${service}:${method}:${path}:${fingerprint}`;
  let key = sessionStorage.getItem(storageKey);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
  }
  const result = await request<T>(service, path, { method, body, key });
  sessionStorage.removeItem(storageKey);
  return result;
}
