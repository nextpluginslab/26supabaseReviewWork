import type { Runtime } from "./runtime.ts";

export async function sendOneClaimEmail(rt: Runtime) {
  const job = await rt.claimRpc<
    {
      reward_id: string;
      tester_id: string;
      lease_id: string;
    } | null
  >("claim_email", null);
  if (!job) return { processed: false };
  const lease = { id: job.reward_id, lease_id: job.lease_id };
  try {
    await rt.sendClaimEmail(job.tester_id, job.reward_id);
    await rt.claimRpc("email_sent", null, lease);
    return { processed: true, sent: true };
  } catch {
    await rt.claimRpc("email_failed", null, lease);
    return { processed: true, sent: false };
  }
}
