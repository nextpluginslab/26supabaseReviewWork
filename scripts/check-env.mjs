import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const online = process.argv.includes('--online');
let failed = false;
function report(label, ok, detail = '') {
  console.log(`${ok ? 'OK' : 'MISSING/FAILED'} ${label}${detail ? ': ' + detail : ''}`);
  if (!ok) failed = true;
}
function load(path, names) {
  let env = {};
  try { env = parseEnv(readFileSync(path, 'utf8')); } catch {}
  for (const name of names) report(`${path} ${name}`, Boolean(env[name]?.trim()));
  return env;
}
const front = load('frontend/.env.local', ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']);
const back = load('backend/.env.local', ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']);
for (const [name, value] of Object.entries(front)) {
  if (!name.startsWith('NEXT_PUBLIC_') || !value) continue;
  let privileged = /OPENAI|SERVICE_ROLE|SECRET/.test(name) || /^(sk-|sb_secret_)/.test(value);
  try { privileged ||= JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString()).role === 'service_role'; } catch {}
  report(`public variable safety ${name}`, !privileged);
}
async function check(label, url, headers) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    report(label, response.ok, `HTTP ${response.status}`);
    await response.body?.cancel();
  } catch { report(label, false, 'network request failed'); }
}
if (online) {
  const url = front.NEXT_PUBLIC_SUPABASE_URL;
  if (url && front.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    report('expected Supabase project', url === 'https://myjdykfmxspqtgbuoqdt.supabase.co');
    if (url === 'https://myjdykfmxspqtgbuoqdt.supabase.co') {
      await check('Supabase Auth', `${url}/auth/v1/settings`, { apikey: front.NEXT_PUBLIC_SUPABASE_ANON_KEY });
      if (back.SUPABASE_URL === url && back.SUPABASE_SERVICE_ROLE_KEY) {
        await check('Supabase REST schema (server credential)', `${url}/rest/v1/`, {
          apikey: back.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${back.SUPABASE_SERVICE_ROLE_KEY}`,
        });
      } else report('matching backend Supabase configuration', false);
    }
  }
  if (back.OPENAI_API_KEY) await check('OpenAI authentication', 'https://api.openai.com/v1/models', { Authorization: `Bearer ${back.OPENAI_API_KEY}` });
}
process.exitCode = failed ? 1 : 0;
