import { createHandler } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
if (!url || !anonKey) throw new Error("Missing Supabase configuration");

Deno.serve(createHandler({ url, anonKey }));
