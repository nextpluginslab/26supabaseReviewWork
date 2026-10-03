"use client";
import { useEffect, useState, use } from "react";
import { AuthPanel } from "@/components/auth-panel";
import { request } from "@/lib/api-client";
import { session } from "@/lib/supabase";
import type { RemoteSubmission } from "@/lib/contracts";
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <AuthPanel required>
      <Open id={id} />
    </AuthPanel>
  );
}
function Open({ id }: { id: string }) {
  const [error, setError] = useState("");
  useEffect(() => {
    (async () => {
      const [s, auth] = await Promise.all([
        request<RemoteSubmission>("submissions", `/submissions/${id}`),
        session(),
      ]);
      location.replace(
        s.tester_id === auth?.user.id
          ? `/tasks/${s.task_id}`
          : `/tasks/${s.task_id}/results?submission=${s.submission_no}`,
      );
    })().catch((e) => setError(e.message));
  }, [id]);
  return <p className="live-panel">{error || "Opening submission…"}</p>;
}
