// Integration test against the hosted project. No local Supabase or Docker.
// Usage: node scripts/test-agent-api-keys.mjs /absolute/path/backend/.env.local
import { loadEnvFile } from "node:process";
import { randomBytes, randomUUID, createHash } from "node:crypto";

if (process.argv[2]) loadEnvFile(process.argv[2]);
const base = process.env.SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.SUPABASE_ANON_KEY;
if (base !== "https://myjdykfmxspqtgbuoqdt.supabase.co" || !service || !anon) {
  throw new Error("Expected hosted project and server-side credentials are required.");
}
const endpoint = `${base}/functions/v1/api-keys`;
const userIds = [];
let count = 0;
function check(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  count++;
  console.log(`PASS ${label}`);
}
async function request(url, token, method = "GET", body, apiKey = anon) {
  const response = await fetch(url, {
    method,
    headers: { apikey: apiKey, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  // Never include response content in errors: successful responses contain credentials.
  return { status: response.status, data, headers: response.headers };
}
const api = (token, method = "GET", path = "", body) => request(endpoint + path, token, method, body);
const admin = (path, method = "GET", body) => request(base + path, service, method, body, service);
const sha = (key) => createHash("sha256").update(key).digest("hex");
async function createUser() {
  const email = `agent-key-test-${randomUUID()}@example.com`;
  const password = randomBytes(32).toString("base64url");
  const made = await admin("/auth/v1/admin/users", "POST", { email, password, email_confirm: true, app_metadata: { purpose: "agent-api-key-integration-test" } });
  if (made.status !== 200 && made.status !== 201) throw new Error(`Test user creation HTTP ${made.status}`);
  const id = made.data.id; userIds.push(id);
  const login = await request(`${base}/auth/v1/token?grant_type=password`, null, "POST", { email, password });
  if (login.status !== 200 || !login.data.access_token) throw new Error(`Test login HTTP ${login.status}`);
  return { id, token: login.data.access_token };
}
function noSecrets(data) {
  const serialized = JSON.stringify(data);
  return !serialized.includes('"key_hash"') && !serialized.includes('"key"') && !/rwk_[0-9a-f]{64}/.test(serialized);
}

try {
  const alice = await createUser(), bob = await createUser();
  check(true, "two temporary users sign in through hosted Supabase Auth");
  check((await api(null)).status === 401, "unauthenticated management rejected");
  check((await api(anon)).status === 401, "project anon key is not a user session");
  check((await api(service)).status === 401, "service role is not an interactive user session");
  const preflight = await request(endpoint, null, "OPTIONS");
  check(preflight.status === 204 && preflight.headers.get("access-control-allow-methods").includes("DELETE"), "browser CORS preflight");
  const input = { name: "Read-only test agent", scopes: ["tasks:read", "submissions:read"] };
  const made = await api(alice.token, "POST", "", input);
  check(made.status === 201 && /^rwk_[0-9a-f]{64}$/.test(made.data?.key), "create high-entropy Agent key");
  const { key, api_key: metadata } = made.data;
  check(metadata.publisher_id === alice.id && metadata.key_prefix === key.slice(0, 12), "owner derived from verified session");
  check(made.headers.get("cache-control") === "no-store" && !JSON.stringify(metadata).includes("key_hash"), "one-time secret response is not cached and never exposes hash");
  check(Math.abs(Date.parse(metadata.expires_at) - Date.now() - 90 * 86400000) < 60000, "default expiry is 90 days");
  const stored = await admin(`/rest/v1/api_keys?id=eq.${metadata.id}&select=key_hash`);
  check(stored.status === 200 && stored.data[0].key_hash === sha(key), "database stores SHA-256, not plaintext");
  const list = await api(alice.token);
  check(list.status === 200 && list.data.api_keys.length === 1 && noSecrets(list.data), "list returns owner metadata only");
  const otherList = await api(bob.token);
  check(otherList.status === 200 && otherList.data.api_keys.length === 0, "other user cannot list keys");
  check((await api(bob.token, "DELETE", `/${metadata.id}`)).status === 404, "cross-owner revocation rejected");
  check((await api(alice.token, "POST", "", { ...input, publisher_id: bob.id })).status === 422, "owner injection rejected");
  for (const scopes of [[], ["*"], ["payments:write"], ["submissions:write"], ["tasks:read", "tasks:read"], [null]]) {
    check((await api(alice.token, "POST", "", { ...input, scopes })).status === 422, `invalid scopes rejected: ${JSON.stringify(scopes)}`);
  }
  for (const expires_at of [null, "yesterday", "2000-01-01T00:00:00Z", new Date(Date.now() + 367 * 86400000).toISOString()]) {
    check((await api(alice.token, "POST", "", { ...input, expires_at })).status === 422, "invalid expiration rejected");
  }
  check((await api(alice.token, "POST", "", { ...input, name: " " })).status === 422, "blank name rejected");
  check((await api(alice.token, "POST", "", { ...input, name: "x".repeat(9000) })).status === 413, "oversized body rejected");
  const authorize = (token, scopes) => api(token, "POST", "/authorize", { required_scopes: scopes });
  const allowed = await authorize(key, ["tasks:read", "submissions:read"]);
  check(allowed.status === 200 && allowed.data.principal.publisher_id === alice.id && allowed.data.principal.key_id === metadata.id, "Agent authorization returns correct principal");
  check((await authorize(key, ["tasks:write"])).status === 403, "missing scope rejected");
  check((await authorize(key, ["tasks:read", "insights:read"])).status === 403, "all required scopes must be present");
  check((await authorize(key, ["payments:write"])).status === 422, "payment scope cannot be requested");
  check((await authorize(alice.token, ["tasks:read"])).status === 401, "user JWT cannot masquerade as Agent key");
  check((await authorize(key.slice(0, -1) + (key.endsWith("0") ? "1" : "0"), ["tasks:read"])).status === 401, "tampered key rejected even with same prefix");
  for (const [method, path, body] of [["GET", "", undefined], ["POST", "", input], ["DELETE", `/${metadata.id}`, undefined]]) {
    check((await api(key, method, path, body)).status === 403, `Agent cannot ${method} management API`);
  }
  const used = await api(alice.token);
  check(Boolean(used.data.api_keys[0].last_used_at), "successful authorization updates last_used_at");
  for (const token of [anon, alice.token]) {
    const direct = await request(`${base}/rest/v1/api_keys?select=*`, token);
    check([401, 403].includes(direct.status) && !JSON.stringify(direct.data).includes(sha(key)), "direct database hash access denied");
    check([401, 403].includes((await request(`${base}/rest/v1/rpc/authorize_agent_api_key`, token, "POST", { p_key_hash: sha(key), p_required_scopes: ["tasks:read"] })).status), "direct privileged RPC denied");
  }
  const write = await api(alice.token, "POST", "", { name: "Write only", scopes: ["tasks:write"], expires_at: new Date(Date.now() + 86400000).toISOString() });
  check(write.status === 201 && (await authorize(write.data.key, ["tasks:write"])).status === 200, "explicit write scope succeeds");
  check((await authorize(write.data.key, ["tasks:read"])).status === 403, "write scope does not implicitly grant read scope");
  const page1 = await api(alice.token, "GET", "?limit=1");
  const page2 = await api(alice.token, "GET", `?limit=1&cursor=${page1.data.next_cursor}`);
  check(page1.data.api_keys.length === 1 && page2.data.api_keys.length === 1 && page1.data.api_keys[0].id !== page2.data.api_keys[0].id && page2.data.next_cursor === null, "cursor pagination does not repeat keys");
  check((await api(alice.token, "GET", "?limit=0")).status === 422, "invalid pagination rejected");
  const expired = await admin(`/rest/v1/api_keys?id=eq.${write.data.api_key.id}`, "PATCH", { created_at: new Date(Date.now() - 7200000).toISOString(), expires_at: new Date(Date.now() - 3600000).toISOString() });
  check(expired.status === 204 && (await authorize(write.data.key, ["tasks:write"])).status === 401, "expired key rejected");
  const revoked = await api(alice.token, "DELETE", `/${metadata.id}`);
  check(revoked.status === 200 && Boolean(revoked.data.api_key.revoked_at) && noSecrets(revoked.data), "revoke preserves safe metadata");
  check((await authorize(key, ["tasks:read"])).status === 401, "revocation effective on next request");
  const repeated = await api(alice.token, "DELETE", `/${metadata.id}`);
  check(repeated.status === 200 && repeated.data.api_key.revoked_at === revoked.data.api_key.revoked_at, "revoke is idempotent");
  const rows = Array.from({ length: 49 }, () => {
    const secret = "rwk_" + randomBytes(32).toString("hex");
    return { publisher_id: bob.id, name: "Limit fixture", key_hash: sha(secret), key_prefix: secret.slice(0, 12), scopes: ["tasks:read"], expires_at: new Date(Date.now() + 86400000).toISOString() };
  });
  check((await admin("/rest/v1/api_keys", "POST", rows)).status === 201, "create isolated quota fixtures");
  const concurrent = await Promise.all([api(bob.token, "POST", "", input), api(bob.token, "POST", "", input)]);
  check(concurrent.map((r) => r.status).sort().join(",") === "201,429", "parallel creation cannot exceed 50 active keys");
  console.log(`Completed ${count} hosted integration assertions.`);
} finally {
  let cleanupFailed = false;
  for (const id of userIds) {
    const response = await admin(`/auth/v1/admin/users/${id}`, "DELETE");
    if (response.status < 200 || response.status >= 300) { cleanupFailed = true; console.error(`Cleanup failed for temporary user ${id}: HTTP ${response.status}`); }
  }
  if (cleanupFailed) throw new Error("Temporary user cleanup needs attention.");
  console.log("Temporary Auth users and their API keys removed.");
}
