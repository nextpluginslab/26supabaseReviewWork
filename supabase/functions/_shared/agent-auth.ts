// Server-only. Agent scope and resource ownership are separate checks.
export const SCOPES = [
  "tasks:read",
  "tasks:write",
  "submissions:read",
  "insights:read",
  "insights:write",
] as const;
export type Scope = typeof SCOPES[number];
export type AgentPrincipal = {
  key_id: string;
  publisher_id: string;
  scopes: Scope[];
};
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function bearer(req: Request): string {
  const match = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i);
  if (!match) {
    throw new ApiError(
      401,
      "unauthenticated",
      "A Bearer credential is required.",
    );
  }
  return match[1];
}
export function validateScopes(value: unknown): Scope[] {
  if (
    !Array.isArray(value) || value.length < 1 || value.length > SCOPES.length ||
    value.some((s) => !SCOPES.includes(s)) ||
    new Set(value).size !== value.length
  ) {
    throw new ApiError(
      422,
      "invalid_scopes",
      "Provide distinct supported scopes; no wildcard or payment scopes.",
    );
  }
  return [...value].sort() as Scope[];
}
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function database(path: string, init: RequestInit = {}) {
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const response = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/rest/v1/${path}`,
    {
      ...init,
      headers: {
        apikey: secret,
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const known: Record<string, [number, string]> = {
      invalid_api_key: [401, "API key is invalid, expired or revoked."],
      insufficient_scope: [403, "API key lacks a required scope."],
      invalid_scopes: [422, "Unsupported scope."],
      key_limit: [429, "Maximum 50 active keys or 100 creations per 24 hours."],
      invalid_publisher: [403, "A verified active account is required."],
      invalid_expiration: [
        422,
        "Expiry must be in the future and within 365 days.",
      ],
    };
    const error = known[data?.message];
    if (error) throw new ApiError(error[0], data.message, error[1]);
    // Never log database detail: it can include a credential hash or request data.
    console.error(
      JSON.stringify({ event: "api_key_database_error", code: data?.code }),
    );
    throw new ApiError(
      500,
      "internal_error",
      "Unable to process API key request.",
    );
  }
  return data;
}

export async function requireUserSession(
  req: Request,
): Promise<{ id: string }> {
  const token = bearer(req);
  if (token.startsWith("rwk_")) {
    throw new ApiError(
      403,
      "user_session_required",
      "Manage keys with a signed-in user session.",
    );
  }
  const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: {
      apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new ApiError(
      response.status >= 500 ? 503 : 401,
      "unauthenticated",
      "A valid user session is required.",
    );
  }
  const user = await response.json();
  if (
    !UUID.test(user.id ?? "") || !user.email_confirmed_at || user.is_anonymous
  ) {
    throw new ApiError(
      403,
      "email_not_verified",
      "Verify your email before managing keys.",
    );
  }
  return { id: user.id };
}

/** Required scopes must be chosen by the route, never by a business request body. */
export async function requireAgent(
  req: Request,
  scopes: Scope[],
): Promise<AgentPrincipal> {
  const token = bearer(req);
  if (!/^rwk_[a-f0-9]{64}$/.test(token)) {
    throw new ApiError(
      401,
      "invalid_api_key",
      "A valid Agent API key is required.",
    );
  }
  const required = validateScopes(scopes);
  const rows = await database("rpc/authorize_agent_api_key", {
    method: "POST",
    body: JSON.stringify({
      p_key_hash: await sha256(token),
      p_required_scopes: required,
    }),
  });
  if (!rows?.[0]) {
    throw new ApiError(401, "invalid_api_key", "API key is invalid.");
  }
  return rows[0];
}

/** resourcePublisherId must come from the stored resource, not caller input. */
export function requireAgentOwner(
  agent: AgentPrincipal,
  resourcePublisherId: string,
) {
  if (agent.publisher_id !== resourcePublisherId) {
    throw new ApiError(404, "not_found", "Resource not found.");
  }
}
