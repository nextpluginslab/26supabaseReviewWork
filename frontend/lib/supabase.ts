import { createClient, type Session } from "@supabase/supabase-js";
let client: ReturnType<typeof createClient> | undefined;
let current: Session | null = null;
export function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  if (!client) {
    client = createClient(url, key);
    client.auth.onAuthStateChange((_event, session) => {
      current = session;
    });
  }
  return client;
}
export async function session() {
  const { data, error } = await supabase().auth.getSession();
  if (error) throw error;
  current = data.session;
  return current;
}
export function sessionEmail() {
  return current?.user.email ?? null;
}
export function isDemo(id: string) {
  return (
    ["demo", "expired", "mobile", "missing"].includes(id) ||
    id.startsWith("rw-")
  );
}

// Create a private browser-owned guest identity only when an upload/submission
// requires it. Reading public tasks never creates accounts or prompts for login.
let guestSession: Promise<Session> | undefined;
export async function ensureFeedbackSession(): Promise<Session> {
  const existing = await session();
  if (existing) return existing;
  if (!guestSession) {
    guestSession = (async () => {
      const { data, error } = await supabase().auth.signInAnonymously();
      if (error || !data.session) {
        throw error || new Error("Unable to start feedback session.");
      }
      current = data.session;
      return data.session;
    })().finally(() => {
      guestSession = undefined;
    });
  }
  return guestSession;
}
