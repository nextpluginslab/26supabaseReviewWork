"use client";
import { PaymentLink } from "./payment-link";

import "./results.css";
import { AuthPanel } from "@/components/auth-panel";
import { isDemo } from "@/lib/supabase";
import { getSubmissionDetail, decide, refreshEvidence } from "./api";
import { mutate } from "@/lib/api-client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  ExternalLink,
  FileImage,
  FlaskConical,
  LoaderCircle,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  approveSubmission,
  getBudget,
  getDistribution,
  getResults,
  getSession,
  money,
  signIn,
  signOut,
} from "./api";
import type { Results, ReviewStatus } from "./types";

const statusLabels: Record<ReviewStatus, string> = {
  awaiting_publisher: "Needs review",
  accepted: "Confirmed",
  changes_requested: "More info requested",
  declined: "Declined",
};
const paymentLabels = {
  awaiting_confirmation: "Not paid",
  paid: "Paid · simulated",
  pending: "Pending · simulated",
  failed: "Payment failed",
  processing: "Payment processing",
  unknown: "Reconciling payment",
  reconciliation_required: "Reconciliation required",
  not_payable: "No payment",
  not_required: "Not required",
};
const date = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Phoenix",
  }).format(new Date(value));
function Status({ status }: { status: ReviewStatus }) {
  return (
    <span className={`status ${status}`}>
      <span />
      {statusLabels[status]}
    </span>
  );
}

export function ResultsPage({ taskId }: { taskId: string }) {
  return isDemo(taskId) ? (
    <ResultsContent taskId={taskId} />
  ) : (
    <AuthPanel required>
      <ResultsContent taskId={taskId} />
    </AuthPanel>
  );
}
function ResultsContent({ taskId }: { taskId: string }) {
  const live = !isDemo(taskId);
  const paymentText = (status: keyof typeof paymentLabels) =>
    live && status === "paid"
      ? "Paid · test transfer"
      : live && status === "pending"
        ? "Payment pending"
        : paymentLabels[status];
  const [reviewReason, setReviewReason] = useState("");
  const [detailError, setDetailError] = useState("");
  const [data, setData] = useState<Results | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [evidence, setEvidence] = useState<{
    name: string;
    url: string;
    type: "image" | "video";
  } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getResults(taskId);
      setData(result);
      setQuestion(result.task.questions[0]?.id ?? "");
      setSession(getSession());
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "We couldn’t load these results. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [taskId]);
  useEffect(() => {
    void load();
    const sync = () =>
      setDetail(new URLSearchParams(window.location.search).get("submission"));
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  const openDetail = (id: string | null) => {
    setDetailError("");
    setReviewReason("");
    setDetail(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("submission", id);
    else url.searchParams.delete("submission");
    window.history.replaceState({}, "", url);
  };
  const filtered = useMemo(
    () =>
      data?.submissions.filter(
        (s) =>
          (filter === "all" || s.status === filter) &&
          `${s.name} ${s.id} ${s.summary}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ) ?? [],
    [data, filter, search],
  );
  const remoteDetailId = data?.submissions.find(
    (s) => s.id === detail,
  )?.backendId;
  useEffect(() => {
    if (!live || !remoteDetailId) return;
    let active = true;
    setDetailError("Loading submission details…");
    getSubmissionDetail(remoteDetailId)
      .then((row) => {
        if (active) {
          setData((d) =>
            d
              ? {
                  ...d,
                  submissions: d.submissions.map((s) =>
                    s.backendId === row.backendId ? row : s,
                  ),
                }
              : d,
          );
          setDetailError("");
        }
      })
      .catch((e) => {
        if (active) setDetailError(e.message);
      });
    return () => {
      active = false;
    };
  }, [live, remoteDetailId]);
  async function review(action: "request_changes" | "decline") {
    if (!selected || busy) return;
    setBusy(true);
    setActionError("");
    try {
      setData(await decide(taskId, selected, action, reviewReason));
      setDetail(null);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pageCount = Math.max(1, Math.ceil(filtered.length / 5));
  const selected = data?.submissions.find((s) => s.id === detail);
  const confirming = data?.submissions.find((s) => s.id === confirm);
  const budget = data ? getBudget(data) : { paid: 0, pending: 0, remaining: 0 };
  const distribution = data ? getDistribution(data, question) : [];
  const total =
    data?.statistics?.total_submissions ?? data?.submissions.length ?? 0;
  const awaiting =
    data?.statistics?.status_counts.awaiting_publisher ??
    data?.submissions.filter((s) => s.status === "awaiting_publisher").length ??
    0;
  const requestConfirm = (id: string) => {
    setActionError("");
    setConfirm(id);
    if (!session) setLoginOpen(true);
  };
  const approve = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    setActionError("");
    try {
      const next = await approveSubmission(taskId, confirm, confirming);
      setData(next);
      setConfirm(null);
      setNotice(
        live
          ? "Feedback accepted. A secure reward email is queued when payment is due. Payment status will update after processing."
          : "Feedback confirmed. Mock payment updated.",
      );
    } catch (e) {
      setActionError(
        e instanceof Error
          ? e.message
          : "Confirmation failed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="results-page">
      {!live && (
        <header className="results-header">
          <span className="brand">
            reviewWork <span>/</span> Results
          </span>
          {!live && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                session ? (signOut(), setSession(null)) : setLoginOpen(true)
              }
            >
              {session ? "Sign out" : "Developer login"}
            </Button>
          )}
        </header>
      )}
      <main className="results-main">
        {loading ? (
          <div className="empty-state" role="status">
            <LoaderCircle className="animate-spin" size={20} />
            Loading results…
          </div>
        ) : error || !data ? (
          <div className="empty-state" role="alert">
            <p>{error || "Results unavailable."}</p>
            <Button variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {live && (
              <a href={`/funding#${taskId}`} className="funding-result-link">
                Manage funding →
              </a>
            )}
            <div className="page-heading">
              <h1>Results</h1>
              <p>{data.task.title}</p>
            </div>
            <div className="summary-line">
              <span>
                <strong>{total}</strong> submissions
              </span>
              <span>
                <strong>{awaiting}</strong> need review
              </span>
              <span className="remaining-budget">
                <strong>{money(budget.remaining)}</strong> remaining budget
              </span>
              <span className="demo-label">
                {live ? "Stripe Sandbox" : "Demo · Simulated payments"}
              </span>
              <Button variant="outline" onClick={() => void load()}>
                Refresh
              </Button>
            </div>
            <section className="overview" aria-label="Feedback overview">
              <div className="distribution">
                <h2>Answer distribution</h2>
                <select
                  aria-label="Question to show"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                >
                  {data.task.questions.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.text}
                    </option>
                  ))}
                </select>
                <div className="chart">
                  {distribution.map((option) => (
                    <div className="chart-row" key={option.id}>
                      <span>{option.label}</span>
                      <div className="chart-track">
                        <span
                          style={{
                            width: `${total ? (option.count / total) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <span className="chart-count">
                        {option.count}{" "}
                        <small>
                          (
                          {total ? Math.round((option.count / total) * 100) : 0}
                          %)
                        </small>
                      </span>
                    </div>
                  ))}
                </div>
                <small className="scope-note">
                  All submissions · Latest answers
                </small>
              </div>
              <div className="ai-summary">
                <h2>AI summary</h2>
                <ul>
                  {data.summary.map((item) => (
                    <li key={item.title}>
                      {item.text}{" "}
                      <button
                        onClick={() => openDetail(item.sources[0])}
                        aria-label={`View source ${item.sources[0]}`}
                      >
                        ↗
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
            <section className="submissions" aria-label="Submissions">
              <div className="list-heading">
                <h2>
                  Submissions <span>{total}</span>
                </h2>
              </div>
              <div className="table-controls">
                <label className="search-field">
                  <Search size={16} />
                  <input
                    aria-label="Search submissions"
                    placeholder="Search submissions"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                  />
                </label>
                <select
                  aria-label="Filter by status"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="all">All statuses</option>
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Participant</th>
                      <th>Answer</th>
                      <th>Evidence</th>
                      <th>Status</th>
                      <th>Payment</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice((page - 1) * 5, page * 5).map((s) => (
                      <tr key={s.id}>
                        <td>
                          <button
                            className="participant"
                            onClick={() => openDetail(s.id)}
                          >
                            <strong>{s.name}</strong>
                            <small>{s.id}</small>
                          </button>
                        </td>
                        <td>
                          <button
                            className="feedback-cell"
                            onClick={() => openDetail(s.id)}
                          >
                            {s.summary}
                          </button>
                        </td>
                        <td>
                          <button
                            className="evidence-link"
                            onClick={() => openDetail(s.id)}
                          >
                            {s.evidence.length} file
                            {s.evidence.length === 1 ? "" : "s"}
                          </button>
                        </td>
                        <td>
                          <Status status={s.status} />
                        </td>
                        <td>
                          <span className="payment-label">
                            {paymentText(s.payment)}
                          </span>
                        </td>
                        <td>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openDetail(s.id)}
                          >
                            {s.status === "awaiting_publisher"
                              ? "Review"
                              : "View"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filtered.length === 0 && (
                <div className="empty-state">
                  <h3>No matching submissions</h3>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setFilter("all");
                      setSearch("");
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              )}
              <div className="table-footer">
                <span>
                  {filtered.length
                    ? `${(page - 1) * 5 + 1}–${Math.min(page * 5, filtered.length)}`
                    : "0"}{" "}
                  of {filtered.length}
                </span>
                <div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Previous page"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft size={16} />
                  </Button>
                  <span>
                    Page {page} of {pageCount}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Next page"
                    disabled={page >= pageCount}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight size={16} />
                  </Button>
                </div>
              </div>
            </section>
          </>
        )}
      </main>
      <Dialog
        open={Boolean(detail)}
        onOpenChange={(open) => !open && openDetail(null)}
      >
        <DialogContent className="detail-dialog">
          <DialogTitle className="dialog-title">Submission details</DialogTitle>
          <DialogDescription className="dialog-description">
            Original feedback, evidence, and your review.
          </DialogDescription>
          {selected && data ? (
            <>
              <PaymentLink key={selected.rewardId || selected.id} rewardId={selected.rewardId} amount={data.task.reward} paid={selected.payment === "paid"} live={live} />
              <div className="detail-person">
                <div>
                  <strong>{selected.name}</strong>
                  <small>
                    {selected.id} · {date(selected.submittedAt)} MST
                  </small>
                </div>
                <Status status={selected.status} />
              </div>
              <div className="detail-section">
                <h3>Answers & reasons</h3>
                {data.task.questions.map((q, i) => {
                  const answer = selected.answers.find(
                    (a) => a.questionId === q.id,
                  );
                  return (
                    <div className="answer" key={q.id}>
                      <h4>
                        <span>{i + 1}.</span>
                        {q.text}
                      </h4>
                      <span className="answer-choice">
                        {q.options.find((o) => o.id === answer?.optionId)
                          ?.label ?? "No answer"}
                      </span>
                      <p>{answer?.reason}</p>
                    </div>
                  );
                })}
              </div>
              <div className="detail-section">
                <h3>
                  Original evidence{" "}
                  <span className="muted-label">
                    {live ? "Private uploads" : "Demo assets"}
                  </span>
                </h3>
                <div className="evidence-list">
                  {selected.evidence.map((e) => (
                    <button
                      className="evidence-preview"
                      key={e.url}
                      onClick={async () => {
                        try {
                          setEvidence(live ? await refreshEvidence(e) : e);
                        } catch (err) {
                          setDetailError((err as Error).message);
                        }
                      }}
                    >
                      {e.type === "image" ? (
                        <img src={e.url} alt={e.name} />
                      ) : (
                        <FileImage />
                      )}
                      <span>
                        {e.name}
                        <ExternalLink size={14} />
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="detail-ai">
                <h3>
                  <Sparkles size={17} />
                  AI review notes
                </h3>
                {selected.ai.status === "ready" ? (
                  <p>{selected.ai.note}</p>
                ) : (
                  <p>
                    {selected.ai.status === "generating"
                      ? "Summary is being generated. You can review the original feedback and confirm now."
                      : "AI summary is unavailable. The original feedback is ready for your review."}
                  </p>
                )}
                <small>
                  Advisory only · AI does not approve feedback or payments.
                </small>
              </div>
              {live && (
                <>
                  <p role="status">{detailError}</p>
                  <section>
                    <h3>Revision history</h3>
                    {selected.history?.map((r) => (
                      <details key={r.id}>
                        <summary>
                          Revision {r.revision_no} · {date(r.submitted_at)}
                        </summary>
                        <p>{r.operation_notes}</p>
                        {r.answers.map((a) => (
                          <p key={a.question_key}>
                            {
                              data.task.questions.find(
                                (q) => q.id === a.question_key,
                              )?.text
                            }
                            : {a.selected_option_key} — {a.reason}
                          </p>
                        ))}
                      </details>
                    ))}
                  </section>
                  {["awaiting_publisher", "changes_requested"].includes(
                    selected.status,
                  ) && (
                    <section>
                      <label>
                        Review reason
                        <textarea
                          value={reviewReason}
                          onChange={(e) => setReviewReason(e.target.value)}
                        />
                      </label>
                      <Button
                        disabled={busy || !reviewReason.trim() || !!detailError}
                        onClick={() => void review("request_changes")}
                      >
                        Request more information
                      </Button>
                      <Button
                        disabled={busy || !reviewReason.trim() || !!detailError}
                        onClick={() => void review("decline")}
                      >
                        Decline
                      </Button>
                      {actionError && <p role="alert">{actionError}</p>}
                    </section>
                  )}
                  {selected.payment === "failed" && selected.rewardId && (
                    <Button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await mutate(
                            "payments",
                            `/rewards/${selected.rewardId}/retry`,
                            {},
                          );
                          await load();
                        } catch (e) {
                          setActionError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Retry payment
                    </Button>
                  )}
                </>
              )}
              {selected.reviewReason && (
                <div className="review-reason">
                  <h3>Publisher review reason</h3>
                  <p>{selected.reviewReason}</p>
                </div>
              )}
              <div className="detail-payment">
                <span>
                  <CreditCard size={16} />
                  Payment status
                </span>
                <strong>{paymentText(selected.payment)}</strong>
              </div>
              <div className="detail-actions">
                <small>
                  {money(data.task.reward)} reward · Simulated payment
                </small>
                {selected.status === "accepted" ? (
                  <span className="confirmed-label">
                    <CheckCheck size={17} />
                    Confirmed
                  </span>
                ) : selected.status === "declined" ? (
                  <span className="muted-label">Review completed</span>
                ) : (
                  <Button onClick={() => requestConfirm(selected.id)}>
                    <Check size={16} />
                    {session ? "Confirm feedback" : "Sign in to confirm"}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p className="empty-state">This submission could not be found.</p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={loginOpen}
        onOpenChange={(open) => {
          setLoginOpen(open);
          if (!open && !session) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogTitle className="dialog-title">
            Your feedback workspace
          </DialogTitle>
          <DialogDescription className="dialog-description">
            Sign in as the developer to review and confirm submissions.
          </DialogDescription>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setLoginBusy(true);
              setActionError("");
              try {
                const user = await signIn(email.trim());
                setSession(user);
                setLoginOpen(false);
                setNotice("Signed in to the demo workspace.");
              } catch {
                setActionError(
                  "Unable to start the demo session. Please try again.",
                );
              } finally {
                setLoginBusy(false);
              }
            }}
          >
            <label className="form-label" htmlFor="email">
              Email address
            </label>
            <input
              id="email"
              className="form-input"
              type="email"
              required
              placeholder="you@company.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <div className="info-note">
              <FlaskConical size={17} />
              <span>
                Demo login only. Any valid email works; no email is sent and no
                real account is created.
              </span>
            </div>
            {actionError && (
              <p role="alert" className="error-message">
                {actionError}
              </p>
            )}
            <Button className="w-full" type="submit" disabled={loginBusy}>
              {loginBusy ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <ArrowRight size={16} />
              )}
              Continue to demo
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(confirm) && Boolean(session) && !loginOpen}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(e) => busy && e.preventDefault()}
          onPointerDownOutside={(e) => busy && e.preventDefault()}
        >
          <DialogTitle className="dialog-title">
            Confirm this feedback?
          </DialogTitle>
          <DialogDescription className="dialog-description">
            You’re accepting {confirming?.name}’s submission and authorizing a
            {live
              ? "Stripe Sandbox payment (when a reward is due)."
              : "simulated payment."}
          </DialogDescription>
          <div className="confirmation-lines">
            <div>
              <span>Recipient</span>
              <strong>
                {confirming?.name} · {confirming?.id}
              </strong>
            </div>
            <div>
              <span>Reward</span>
              <strong>{money(data?.task.reward ?? 0)} USD</strong>
            </div>
            <div>
              <span>Remaining budget</span>
              <strong>
                {money(budget.remaining)} <ArrowRight size={13} />{" "}
                {money(budget.remaining - (data?.task.reward ?? 0))}
              </strong>
            </div>
          </div>
          <div className="info-note">
            <FlaskConical size={17} />
            <span>
              {live
                ? "This authorizes a Stripe test transfer. Accepted feedback reserves its reward until payment succeeds."
                : "Mock payment. No Stripe request is made and no real money is transferred."}
            </span>
          </div>
          {actionError && (
            <p role="alert" className="error-message">
              {actionError}
            </p>
          )}
          {budget.remaining < (data?.task.reward ?? 0) && (
            <p className="error-message">
              Insufficient budget. This submission will remain unconfirmed.
            </p>
          )}
          <Button
            className="w-full"
            disabled={busy || budget.remaining < (data?.task.reward ?? 0)}
            onClick={() => void approve()}
          >
            {busy ? (
              <LoaderCircle className="animate-spin" size={16} />
            ) : (
              <Check size={16} />
            )}
            {busy
              ? "Confirming…"
              : data?.task.reward === 0
                ? "Confirm feedback"
                : `Confirm & ${live ? "authorize" : "simulate"} ${money(data?.task.reward ?? 0)} payment`}
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(evidence)}
        onOpenChange={(open) => !open && setEvidence(null)}
      >
        <DialogContent className="evidence-dialog">
          <DialogTitle className="dialog-title">{evidence?.name}</DialogTitle>
          <DialogDescription className="dialog-description">
            {live
              ? "Private participant evidence"
              : "Illustrative demo evidence · not a real participant upload"}
          </DialogDescription>
          {evidence?.type === "image" ? (
            <img src={evidence.url} alt={evidence.name} />
          ) : (
            evidence && <video controls src={evidence.url} />
          )}
        </DialogContent>
      </Dialog>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
