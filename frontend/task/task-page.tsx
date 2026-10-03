"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  FileImage,
  FileVideo,
  Loader2,
  Mail,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import * as api from "./api";
import { AuthPanel } from "@/components/auth-panel";
import { isDemo } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";
import "./task.css";
import type { Evidence, Feedback, Submission, Task } from "./types";
import { MIME_TYPES, validateFeedback, validateFile } from "./validation";

const emptyFeedback = (): Feedback => ({
  email: "",
  notes: "",
  answers: {},
  evidence: [],
});
const money = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    amount / 100,
  );
const date = (task: Task) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: task.timezone,
  }).format(new Date(task.deadline));
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
type UploadItem = { key: string; file: File; progress: number; error?: string };

function EvidencePreview({
  evidence,
  onRemove,
}: {
  evidence: Evidence;
  onRemove?: () => void;
}) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    api
      .getEvidence(evidence.path)
      .then((blob) => {
        if (!active) return;
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        } else setFailed(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [evidence.path]);
  const Icon = evidence.type.startsWith("video") ? FileVideo : FileImage;
  return (
    <div className="fw-file-row">
      <span className="fw-file-icon">
        <Icon size={20} />
      </span>
      <div className="fw-file-info">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer">
            {evidence.name}
            <ArrowUpRight size={13} />
          </a>
        ) : (
          <strong>{evidence.name}</strong>
        )}
        <span>
          {(evidence.size / 1024 / 1024).toFixed(2)} MB ·{" "}
          {failed
            ? "File unavailable — upload again"
            : evidence.path.startsWith("remote:")
              ? "Uploaded securely"
              : "Saved locally"}
        </span>
      </div>
      {failed ? (
        <span className="fw-error-text">Unavailable</span>
      ) : (
        <Check size={17} className="fw-green" />
      )}
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove ${evidence.name}`}
          onClick={onRemove}
        >
          <X size={16} />
        </Button>
      )}
    </div>
  );
}

export function TaskPage({ taskId }: { taskId: string }) {
  const [authEmail, setAuthEmail] = useState("");
  const change = useCallback(
    (s: Session | null) => setAuthEmail(s?.user.email || ""),
    [],
  );
  if (isDemo(taskId)) return <TaskContent taskId={taskId} />;
  return (
    <>
      <AuthPanel onChange={change} />
      <TaskContent key={authEmail} taskId={taskId} authEmail={authEmail} />
    </>
  );
}
function TaskContent({
  taskId,
  authEmail = "",
}: {
  taskId: string;
  authEmail?: string;
}) {
  const live = !isDemo(taskId);
  const [task, setTask] = useState<Task>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(emptyFeedback);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifiedEmail, setVerifiedEmail] = useState(authEmail);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(Date.now());
  const fileInput = useRef<HTMLInputElement>(null);
  const editing = !submission || submission.status === "changes_requested";
  const locked = !editing || busy || (live && !authEmail);
  const expired = Boolean(
    task &&
      (task.acceptingSubmissions === false ||
        now >= new Date(task.deadline).getTime()) &&
      !submission,
  );
  const uploading = uploads.some((u) => !u.error);

  async function load() {
    setLoading(true);
    setLoadError("");
    try {
      const nextTask = await api.getTask(taskId);
      const existing = await api.getSubmission(taskId);
      setTask(nextTask);
      setSubmission(existing);
      const draft = api.loadDraft(taskId);
      setFeedback(
        (!existing || existing.status === "changes_requested") && draft
          ? draft
          : (existing?.revisions.at(-1)?.feedback ?? emptyFeedback()),
      );
      if (live) setFeedback((f) => ({ ...f, email: authEmail }));
      if (draft && (!existing || existing.status === "changes_requested"))
        setNotice("Draft restored.");
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load(); /* task page is keyed by taskId */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (loading || !task || !editing) return;
    const timer = setTimeout(() => {
      try {
        api.saveDraft(taskId, feedback);
      } catch {
        setNotice(
          "Your browser couldn’t save this draft. Keep this tab open until you submit.",
        );
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [feedback, loading, task, taskId, editing]);
  useEffect(() => {
    setPreview(
      new URLSearchParams(window.location.search).get("preview") === "1",
    );
  }, []);

  function updateAnswer(
    id: string,
    values: Partial<Feedback["answers"][string]>,
  ) {
    setFeedback((f) => ({
      ...f,
      answers: {
        ...f.answers,
        [id]: { ...(f.answers[id] ?? { optionId: "", reason: "" }), ...values },
      },
    }));
    setErrors((e) => ({ ...e, [id]: "" }));
  }
  async function processUpload(item: UploadItem) {
    setUploads((items) =>
      items.map((u) =>
        u.key === item.key ? { ...u, error: undefined, progress: 0 } : u,
      ),
    );
    try {
      const evidence = await api.uploadEvidence(taskId, item.file, (progress) =>
        setUploads((items) =>
          items.map((u) => (u.key === item.key ? { ...u, progress } : u)),
        ),
      );
      setFeedback((f) => ({ ...f, evidence: [...f.evidence, evidence] }));
      setUploads((items) => items.filter((u) => u.key !== item.key));
      setErrors((e) => ({ ...e, evidence: "" }));
    } catch (error) {
      setUploads((items) =>
        items.map((u) =>
          u.key === item.key ? { ...u, error: errorText(error) } : u,
        ),
      );
    }
  }
  function addFiles(files: FileList | null) {
    if (!files || !task || locked) return;
    const accepted: UploadItem[] = [];
    const rejected: string[] = [];
    Array.from(files).forEach((file) => {
      const error = validateFile(file, task);
      if (error) rejected.push(`${file.name}: ${error}`);
      else accepted.push({ key: crypto.randomUUID(), file, progress: 0 });
    });
    setErrors((e) => ({ ...e, evidence: rejected.join(" ") }));
    setUploads((items) => [...items, ...accepted]);
    accepted.forEach((item) => void processUpload(item));
  }
  async function submit() {
    if (!task || busy) return;
    const nextErrors = validateFeedback(task, feedback, Boolean(submission));
    if (uploads.length)
      nextErrors.evidence =
        "Finish or remove pending uploads before submitting.";
    if (verifiedEmail !== feedback.email.trim().toLowerCase())
      nextErrors.email = "Verify your email before submitting.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      const first = Object.keys(nextErrors)[0];
      document
        .getElementById(
          first === "evidence"
            ? "section-2"
            : first === "email"
              ? "section-4"
              : `question-${first}`,
        )
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setBusy(true);
    try {
      const result = await api.submitFeedback(
        taskId,
        { ...feedback, email: feedback.email.trim().toLowerCase() },
        submission?.revisions.length,
        submission ?? undefined,
      );
      setSubmission(result);
      setNotice("");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setErrors({ submit: errorText(error) });
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    try {
      await api.verifyEmail(feedback.email, code);
      setVerifiedEmail(feedback.email.trim().toLowerCase());
      setCodeOpen(false);
      setErrors((e) => ({ ...e, email: "" }));
    } catch (error) {
      setErrors((e) => ({ ...e, email: errorText(error) }));
    } finally {
      setBusy(false);
    }
  }
  async function refreshStatus() {
    setBusy(true);
    try {
      const result = await api.getSubmission(taskId);
      if (result) setSubmission(result);
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fw-task-page">
      <header className="fw-site-header">
        <a className="fw-brand" href="/">
          reviewWork
        </a>
        <span className="fw-header-label">Product testing</span>
        <span className="fw-sandbox">Sandbox</span>
      </header>
      {loading ? (
        <main className="fw-loading-state">
          <Loader2 className="fw-spin" />
          <p>Loading task…</p>
        </main>
      ) : loadError || !task ? (
        <main className="fw-loading-state">
          <h1>Task unavailable</h1>
          <p role="alert">{loadError}</p>
          <Button onClick={load}>Try again</Button>
        </main>
      ) : (
        <main className="fw-page-shell" id="main-content">
          <section className="fw-task-intro">
            <div className="fw-title-row">
              <div>
                <p className="fw-publisher">{task.appName}</p>
                <h1>{task.title}</h1>
              </div>
              <Button asChild>
                <a href={task.appUrl} target="_blank" rel="noopener noreferrer">
                  {task.appType === "web" ? "Open app" : "Get app"}
                  <ArrowUpRight size={15} />
                </a>
              </Button>
            </div>
            <dl className="fw-task-meta">
              <div>
                <dt>Reward</dt>
                <dd>
                  {money(task.reward)} <span>per accepted submission</span>
                </dd>
              </div>
              {task.minutes > 0 && (
                <div>
                  <dt>Time</dt>
                  <dd>~{task.minutes} min</dd>
                </div>
              )}
              <div>
                <dt>Deadline</dt>
                <dd>{date(task)}</dd>
              </div>
            </dl>
            <p className="fw-description">{task.description}</p>
            <ol className="fw-steps">
              {task.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="fw-supporting-text">
              {task.instructions}
              {task.appType !== "web" && " Open this link on your phone."} If
              you get stuck, share what happened.
            </p>
          </section>
          {notice && (
            <div className="fw-notice" role="status">
              <span>{notice}</span>
              <button
                type="button"
                aria-label="Dismiss notice"
                onClick={() => setNotice("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {submission && (
            <section
              className={`fw-review-panel fw-review-${submission.status}`}
              aria-live="polite"
            >
              <div className="fw-review-top">
                <div>
                  <p className="fw-eyebrow">
                    SUBMISSION {submission.id} · REVISION{" "}
                    {submission.revisions.length}
                  </p>
                  <h2>
                    {
                      {
                        awaiting_publisher: "Awaiting publisher confirmation",
                        changes_requested: "More information requested",
                        accepted: "Feedback accepted",
                        declined: "Feedback declined",
                      }[submission.status]
                    }
                  </h2>
                </div>
              </div>
              <p>
                {submission.status === "awaiting_publisher"
                  ? "Your feedback has been submitted for review."
                  : submission.message ||
                    "The publisher has reviewed your submission."}
              </p>
              {submission.status === "changes_requested" && (
                <p className="fw-review-hint">
                  Update your feedback below. Your submission ID stays the same.
                </p>
              )}
              <div className="fw-review-bottom">
                <span className="fw-badge">
                  {
                    {
                      awaiting_confirmation: "Payment · Awaiting confirmation",
                      pending: "Payment · Pending",
                      paid: "Paid · Test transfer only",
                      failed: "Payment failed · Publisher can retry",
                      processing: "Payment processing",
                      unknown: "Payment reconciling",
                      reconciliation_required: "Payment needs reconciliation",
                      not_payable: "No payment",
                      not_required: "No payment required",
                    }[submission.payment]
                  }
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={refreshStatus}
                >
                  <RefreshCw size={13} />
                  Refresh status
                </Button>
              </div>
              <details className="fw-history">
                <summary>
                  Submission history <ChevronDown size={14} />
                </summary>
                {submission.revisions.map((rev) => (
                  <div key={rev.number} className="fw-revision">
                    <strong>Revision {rev.number}</strong>
                    <span>
                      {new Date(rev.submittedAt).toLocaleString("en-US")}
                    </span>
                    <p>
                      {rev.feedback.evidence.length} evidence file(s) ·{" "}
                      {Object.keys(rev.feedback.answers).length} answers
                    </p>
                    <details>
                      <summary>View submitted content</summary>
                      {rev.feedback.evidence.map((e) => (
                        <EvidencePreview key={e.id} evidence={e} />
                      ))}
                      {task.questions.map((q) => (
                        <div className="fw-history-answer" key={q.id}>
                          <strong>{q.title}</strong>
                          <p>
                            {
                              q.options.find(
                                (o) =>
                                  o.id === rev.feedback.answers[q.id]?.optionId,
                              )?.label
                            }
                          </p>
                          <p>{rev.feedback.answers[q.id]?.reason}</p>
                        </div>
                      ))}
                      {rev.feedback.notes && <p>{rev.feedback.notes}</p>}
                    </details>
                  </div>
                ))}
              </details>
            </section>
          )}
          {expired && (
            <div className="fw-notice fw-warning" role="alert">
              <Clock3 size={18} />
              <span>
                The deadline has passed. New submissions are closed. Existing
                requested updates can still be submitted.
              </span>
            </div>
          )}

          {editing && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              noValidate
            >
              <section
                className="fw-content-card"
                id="section-2"
                data-section="2"
              >
                <h2>Evidence</h2>
                <p className="fw-section-copy">{task.evidenceInstructions}</p>
                <input
                  ref={fileInput}
                  type="file"
                  className="fw-visually-hidden"
                  multiple
                  accept={task.evidenceTypes
                    .flatMap((t) => MIME_TYPES[t])
                    .join(",")}
                  disabled={locked}
                  aria-label="Upload evidence files"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                {editing && (
                  <button
                    type="button"
                    disabled={locked}
                    className={`fw-dropzone ${dragging ? "fw-dragging" : ""}`}
                    onClick={() => fileInput.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      addFiles(e.dataTransfer.files);
                    }}
                  >
                    <Upload size={18} />
                    <strong>
                      <span>Click to upload</span> or drag and drop
                    </strong>
                    <p>
                      {task.evidenceTypes
                        .flatMap((t) =>
                          t === "image"
                            ? ["PNG, JPG, WebP"]
                            : ["MP4, WebM, MOV"],
                        )
                        .join(" · ")}{" "}
                      · Up to 50 MB each
                    </p>
                  </button>
                )}
                <div className="fw-files" aria-live="polite">
                  {feedback.evidence.map((evidence) => (
                    <EvidencePreview
                      key={evidence.id}
                      evidence={evidence}
                      onRemove={
                        locked
                          ? undefined
                          : () =>
                              setFeedback((f) => ({
                                ...f,
                                evidence: f.evidence.filter(
                                  (e) => e.id !== evidence.id,
                                ),
                              }))
                      }
                    />
                  ))}
                  {uploads.map((item) => (
                    <div className="fw-upload-row" key={item.key}>
                      <FileImage size={20} />
                      <div className="fw-file-info">
                        <strong>{item.file.name}</strong>
                        {item.error ? (
                          <span className="fw-error-text">{item.error}</span>
                        ) : (
                          <>
                            <Progress
                              value={item.progress}
                              aria-label={`Uploading ${item.file.name}`}
                            />
                            <span>Uploading {item.progress}%</span>
                          </>
                        )}
                      </div>
                      {item.error && (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void processUpload(item)}
                          >
                            Retry
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove failed upload ${item.file.name}`}
                            onClick={() =>
                              setUploads((items) =>
                                items.filter((i) => i.key !== item.key),
                              )
                            }
                          >
                            <X size={15} />
                          </Button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {errors.evidence && (
                  <p className="fw-error-text" role="alert">
                    {errors.evidence}
                  </p>
                )}
                <div className="fw-field">
                  <label htmlFor="experience-notes">
                    Additional context <span>Optional</span>
                  </label>
                  <textarea
                    id="experience-notes"
                    rows={3}
                    maxLength={5000}
                    disabled={locked}
                    value={feedback.notes}
                    onChange={(e) =>
                      setFeedback((f) => ({ ...f, notes: e.target.value }))
                    }
                    placeholder="Describe any blockers (optional)"
                  />
                </div>
                <p className="fw-supporting-text">
                  Evidence is shared with the publisher. Screenshots may be
                  analyzed by AI.
                </p>
              </section>

              {task.questions.length > 0 && (
                <section
                  className="fw-content-card"
                  id="section-3"
                  data-section="3"
                >
                  <h2>Questions</h2>
                  <div className="fw-questions">
                    {task.questions.map((q, index) => (
                      <fieldset
                        className="fw-question"
                        key={q.id}
                        id={`question-${q.id}`}
                        disabled={locked}
                      >
                        <legend>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          {q.title}
                          <span className="fw-required-star">*</span>
                        </legend>
                        <RadioGroup
                          aria-label={q.title}
                          value={feedback.answers[q.id]?.optionId ?? ""}
                          onValueChange={(optionId) =>
                            updateAnswer(q.id, { optionId })
                          }
                          disabled={locked}
                        >
                          {q.options.map((option) => (
                            <label
                              className={`fw-option ${feedback.answers[q.id]?.optionId === option.id ? "fw-selected" : ""}`}
                              key={option.id}
                              htmlFor={`${q.id}-${option.id}`}
                            >
                              <RadioGroupItem
                                id={`${q.id}-${option.id}`}
                                value={option.id}
                              />
                              {option.label}
                            </label>
                          ))}
                        </RadioGroup>
                        <label
                          className="fw-reason-label"
                          htmlFor={`reason-${q.id}`}
                        >
                          Why? <span>*</span>
                        </label>
                        <textarea
                          id={`reason-${q.id}`}
                          aria-invalid={!!errors[q.id]}
                          aria-describedby={
                            errors[q.id] ? `error-${q.id}` : undefined
                          }
                          rows={3}
                          maxLength={5000}
                          value={feedback.answers[q.id]?.reason ?? ""}
                          onChange={(e) =>
                            updateAnswer(q.id, { reason: e.target.value })
                          }
                          placeholder="Explain your answer"
                        />
                        {errors[q.id] && (
                          <p
                            className="fw-error-text"
                            id={`error-${q.id}`}
                            role="alert"
                          >
                            {errors[q.id]}
                          </p>
                        )}
                      </fieldset>
                    ))}
                  </div>
                </section>
              )}

              <section
                className="fw-content-card submit-card"
                id="section-4"
                data-section="4"
              >
                <div className="fw-field">
                  <label htmlFor="email">
                    Your email address{" "}
                    <span className="fw-required-star">*</span>
                  </label>
                  <div className="fw-email-row">
                    <div className="fw-email-input">
                      <Mail size={17} />
                      <input
                        type="email"
                        autoComplete="email"
                        id="email"
                        placeholder="you@example.com"
                        disabled={live || locked || !!submission}
                        value={feedback.email}
                        aria-invalid={!!errors.email}
                        onChange={(e) => {
                          setFeedback((f) => ({
                            ...f,
                            email: e.target.value,
                          }));
                          setVerifiedEmail("");
                          setCodeOpen(false);
                        }}
                      />
                    </div>
                    {editing && !live && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          busy ||
                          (!!verifiedEmail &&
                            verifiedEmail ===
                              feedback.email.trim().toLowerCase())
                        }
                        onClick={() => {
                          if (
                            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
                              feedback.email.trim(),
                            )
                          ) {
                            setErrors((e) => ({
                              ...e,
                              email: "Enter a valid email address first.",
                            }));
                            return;
                          }
                          setCodeOpen(true);
                          setErrors((e) => ({ ...e, email: "" }));
                        }}
                      >
                        {verifiedEmail ? (
                          <>
                            <Check size={15} />
                            Verified
                          </>
                        ) : (
                          "Verify email"
                        )}
                      </Button>
                    )}
                  </div>

                  {!live && codeOpen && (
                    <div className="fw-verification">
                      <strong>Demo email verification</strong>
                      <p>
                        No email is sent. Enter <code>123456</code> to try the
                        verification flow.
                      </p>
                      <div className="fw-email-row">
                        <input
                          aria-label="Verification code"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          placeholder="6-digit code"
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                        />
                        <Button type="button" onClick={verify} disabled={busy}>
                          Confirm code
                        </Button>
                      </div>
                    </div>
                  )}
                  {errors.email && (
                    <p className="fw-error-text" role="alert">
                      {errors.email}
                    </p>
                  )}
                </div>
                <p className="fw-supporting-text">
                  {live && !authEmail
                    ? "Sign in above before uploading or submitting. "
                    : ""}
                  Payment requires publisher acceptance and available budget.
                </p>
                {Object.entries(errors)
                  .filter(([key]) =>
                    ["submit", "deadline", "answers"].includes(key),
                  )
                  .map(([key, value]) => (
                    <p key={key} className="fw-error-text" role="alert">
                      {value}
                    </p>
                  ))}
                <div className="fw-submit-footer">
                  <span>
                    {submission && !editing
                      ? "Feedback submitted"
                      : "Draft saved on this device"}
                  </span>
                  <Button
                    type="submit"
                    disabled={locked || expired || uploading}
                  >
                    {busy ? <Loader2 size={16} className="fw-spin" /> : null}
                    {!editing
                      ? "Submitted"
                      : submission
                        ? "Submit updated feedback"
                        : "Submit feedback"}
                  </Button>
                </div>
              </section>
            </form>
          )}
          {!live && preview && (
            <details className="fw-demo-tools">
              <summary>
                Mock preview controls <ChevronDown size={14} />
              </summary>
              <p>
                Local demo only. No email, AI review, upload server, or payment
                service is connected. Uploaded files stay in this browser.
              </p>
              <div className="fw-demo-links">
                <a href="/tasks/expired">Closed task</a>
                <a href="/tasks/mobile">Mobile task</a>
                <a href="/tasks/missing">Missing task</a>
              </div>
              {submission && (
                <>
                  <label htmlFor="review-preview">
                    Simulate publisher review
                  </label>
                  <select
                    id="review-preview"
                    disabled={busy}
                    value={`${submission.status}:${submission.payment}`}
                    onChange={async (e) => {
                      const [status, payment] = e.target.value.split(":");
                      setBusy(true);
                      try {
                        setSubmission(
                          await api.simulateReview(
                            taskId,
                            status as Submission["status"],
                            payment as Submission["payment"],
                          ),
                        );
                      } catch (error) {
                        setNotice(errorText(error));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <option value="awaiting_publisher:awaiting_confirmation">
                      Awaiting publisher confirmation
                    </option>
                    <option value="changes_requested:awaiting_confirmation">
                      More information requested
                    </option>
                    <option value="accepted:pending">
                      Accepted · Payment pending
                    </option>
                    <option value="accepted:paid">
                      Accepted · Paid (test transfer)
                    </option>
                    <option value="accepted:failed">
                      Accepted · Payment failed
                    </option>
                    <option value="declined:not_payable">
                      Declined · No payment
                    </option>
                  </select>
                </>
              )}
            </details>
          )}
        </main>
      )}
    </div>
  );
}
