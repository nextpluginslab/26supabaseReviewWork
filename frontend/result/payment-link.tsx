"use client";
import { useState } from "react";
import { request } from "@/lib/api-client";
import { Button } from "./ui/button";

export function PaymentLink(
  { rewardId, amount, paid, live }: {
    rewardId?: string;
    amount: number;
    paid: boolean;
    live: boolean;
  },
) {
  const [link, setLink] = useState<{ url: string; expires_at: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function create() {
    setBusy(true);
    setMessage("");
    try {
      setLink(
        await request("payments", `/rewards/${rewardId}/claim-link`, {
          method: "POST",
          body: {},
        }),
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Payment link"
      style={{
        border: "1px solid #dce5df",
        borderRadius: 10,
        padding: 16,
        margin: "16px 0",
      }}
    >
      <strong>Payment link</strong>
      {amount === 0
        ? <p>No payout is required for this submission.</p>
        : paid
        ? <p>This reward has already been paid.</p>
        : !live
        ? <p>Payment links are available for real submissions.</p>
        : !rewardId
        ? <p>Confirm this feedback and authorize payment to create a link.</p>
        : (
          <>
            <p>
              Send this private link to the feedback provider. They can set up
              their payout without logging in or receiving an automated email.
            </p>
            {link && (
              <>
                <input
                  aria-label="Payment link URL"
                  readOnly
                  value={link.url}
                  onFocus={(e) => e.target.select()}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: 10,
                    margin: "8px 0",
                  }}
                />
                <p>
                  Expires{" "}
                  {new Date(link.expires_at).toLocaleDateString()}. Share only
                  with this recipient.
                </p>
                <Button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link.url);
                      setMessage("Payment link copied.");
                    } catch {
                      setMessage("Select the link above and copy it manually.");
                    }
                  }}
                >
                  Copy payment link
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void create()}
            >
              {busy
                ? "Creating…"
                : link
                ? "Replace link"
                : "Create payment link"}
            </Button>
            {link && <p>Replacing the link invalidates the previous one.</p>}
          </>
        )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
