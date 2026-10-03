"use client";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  Copy,
  ChevronDown,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Question } from "../task/types";
import { createTask } from "./api";
import { blankDraft, cents, validateDraft, type Draft } from "./model";
import "./create-task.css";
const draftKey = "reviewwork:task-creation-draft:v1";
function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="ct-field">
      <label
        htmlFor={id}
        className={
          ["appName", "appUrl", "budget", "reward", "deadline"].includes(id)
            ? "ct-required-label"
            : undefined
        }
      >
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="ct-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function CreateTaskPage() {
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [ready, setReady] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [more, setMore] = useState(false);
  const [timezone, setTimezone] = useState("");
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof createTask>
  > | null>(null);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const defaults = blankDraft();
    setDraft(defaults);
    try {
      const stored = localStorage.getItem(draftKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (
          !Array.isArray(parsed.questions) ||
          !Array.isArray(parsed.evidenceTypes)
        )
          throw Error();
        setDraft({
          ...defaults,
          ...parsed,
          budget: parsed.budget?.trim() ? parsed.budget : defaults.budget,
          reward: parsed.reward?.trim() ? parsed.reward : defaults.reward,
          deadline: parsed.deadline?.trim()
            ? parsed.deadline
            : defaults.deadline,
          questions: parsed.questions.filter(
            (q: Question) =>
              q.title.trim() || q.options.some((o) => o.label.trim()),
          ),
        });
        setMessage("Draft restored.");
      }
    } catch {
      setMessage("The saved draft could not be restored.");
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready || result) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify(draft));
      } catch {
        setMessage("Draft could not be saved. Keep this page open.");
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, ready, result]);
  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: "" }));
  }
  function updateQuestion(id: string, fn: (q: Question) => Question) {
    setDraft((d) => ({
      ...d,
      questions: d.questions.map((q) => (q.id === id ? fn(q) : q)),
    }));
    setErrors((e) => ({ ...e, [id]: "" }));
  }
  function moveQuestion(index: number, direction: number) {
    setDraft((d) => {
      const questions = [...d.questions];
      [questions[index], questions[index + direction]] = [
        questions[index + direction],
        questions[index],
      ];
      return { ...d, questions };
    });
  }
  function moveOption(question: Question, index: number, direction: number) {
    updateQuestion(question.id, (q) => {
      const options = [...q.options];
      [options[index], options[index + direction]] = [
        options[index + direction],
        options[index],
      ];
      return { ...q, options };
    });
  }
  function check() {
    const next = validateDraft(draft);
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) {
      setPreview(false);
      if (
        ![
          "appName",
          "appUrl",
          "evidenceTypes",
          "budget",
          "reward",
          "deadline",
        ].includes(first)
      )
        setMore(true);
      setTimeout(() => document.getElementById(first)?.focus(), 0);
      return false;
    }
    return true;
  }
  async function publish() {
    if (busy || !check()) return;
    setBusy(true);
    setMessage("");
    try {
      const published = await createTask(draft);
      setResult(published);
      try {
        localStorage.removeItem(draftKey);
      } catch {}
      window.scrollTo({ top: 0 });
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Publishing failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
    } catch {
      setMessage("Copy unavailable. Select and copy the link below.");
    }
  }
  const inputProps = (key: keyof Draft) => ({
    id: key,
    "aria-required": [
      "appName",
      "appUrl",
      "budget",
      "reward",
      "deadline",
    ].includes(key),
    value: String(draft[key]),
    "aria-invalid": !!errors[key],
    "aria-describedby": errors[key] ? `${key}-error` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      update(key, e.target.value as never),
  });
  const reward = cents(draft.reward) ?? 0,
    budget = cents(draft.budget) ?? 0;
  return (
    <div className="ct-page">
      <header className="ct-header">
        <a href="/">reviewWork</a>
        <span>Publisher</span>
        <small>Sandbox</small>
      </header>
      <main>
        {result ? (
          <>
            <div className="ct-heading">
              <div>
                <p>Task created</p>
                <h1>{result.task.title}</h1>
              </div>
              <span className="ct-created">
                <Check size={15} /> Demo published
              </span>
            </div>
            <p className="ct-muted">
              This mock task is available in this browser only. No payment was
              collected.
            </p>
            <section className="ct-section">
              <h2>Task links</h2>
              {[
                ["Tester page", result.testUrl],
                ["Results page", result.resultsUrl],
              ].map(([label, url]) => (
                <div className="ct-link" key={label}>
                  <label htmlFor={label}>{label}</label>
                  <div>
                    <input
                      id={label}
                      readOnly
                      value={url}
                      onFocus={(e) => e.target.select()}
                    />
                    <Button
                      variant="outline"
                      onClick={() => void copy(url)}
                      aria-label={`Copy ${label.toLowerCase()} link`}
                    >
                      {copied === url ? (
                        <Check size={15} />
                      ) : (
                        <Copy size={15} />
                      )}
                    </Button>
                    <Button asChild>
                      <a href={url}>
                        Open <ArrowUpRight size={14} />
                      </a>
                    </Button>
                  </div>
                </div>
              ))}
            </section>
            <Button
              variant="outline"
              onClick={() => {
                setDraft(blankDraft());
                setMore(false);
                setResult(null);
                setPreview(false);
                setErrors({});
                setMessage("");
              }}
            >
              Create another task
            </Button>
            {message && (
              <p role="status" className="ct-message">
                {message}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="ct-heading">
              <div>
                <h1>Create task</h1>
                <p>Define the experience. Get useful feedback.</p>
              </div>
              <Button
                variant="outline"
                disabled={!ready || busy}
                onClick={() => {
                  if (preview) setPreview(false);
                  else if (check()) setPreview(true);
                }}
              >
                {preview ? "Edit task" : "Preview"}
              </Button>
            </div>
            {message && (
              <p className="ct-message" role="status">
                {message}
              </p>
            )}
            {!ready ? (
              <p className="ct-muted">Loading draft…</p>
            ) : preview ? (
              <>
                <section className="ct-section ct-preview">
                  <p className="ct-muted">Tester preview</p>
                  <h2>{draft.title.trim() || draft.appName}</h2>
                  <p>
                    {draft.appName}
                    {draft.minutes && ` · ~${draft.minutes} min`}
                  </p>
                  <p>
                    ${(reward / 100).toFixed(2)} per accepted submission ·
                    Deadline {new Date(draft.deadline).toLocaleString("en-US")}{" "}
                    ({timezone})
                  </p>
                  <Button asChild variant="outline">
                    <a href={draft.appUrl} target="_blank" rel="noreferrer">
                      Open app <ArrowUpRight size={14} />
                    </a>
                  </Button>
                  {(draft.instructions || draft.steps) && <h3>Instructions</h3>}
                  <p>{draft.instructions}</p>
                  <ol>
                    {draft.steps
                      .split("\n")
                      .filter((s) => s.trim())
                      .map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                  </ol>
                  <h3>Evidence</h3>
                  <p>{draft.evidenceInstructions}</p>
                  <p className="ct-muted">
                    {draft.evidenceTypes
                      .map((t) =>
                        t === "image" ? "Screenshots" : "Screen recordings",
                      )
                      .join(" / ")}
                  </p>
                  {draft.questions.length > 0 && <h3>Questions</h3>}
                  {draft.questions.map((q, i) => (
                    <div className="ct-preview-question" key={q.id}>
                      <strong>
                        {i + 1}. {q.title}
                      </strong>
                      <ul>
                        {q.options.map((o) => (
                          <li key={o.id}>{o.label}</li>
                        ))}
                      </ul>
                      <p className="ct-muted">A reason is required.</p>
                    </div>
                  ))}
                </section>
                <div className="ct-footer">
                  <span className="ct-muted">
                    Mock publishing · No payment collected
                  </span>
                  <Button disabled={busy} onClick={() => void publish()}>
                    {busy && <Loader2 className="ct-spin" size={15} />}Publish
                    demo task
                  </Button>
                </div>
              </>
            ) : (
              <form
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void publish();
                }}
              >
                <fieldset disabled={busy} className="ct-form">
                  <section
                    className="ct-section ct-required"
                    aria-labelledby="required-heading"
                  >
                    <h2 id="required-heading">
                      <span className="ct-required-badge">Required</span>
                    </h2>
                    <div className="ct-grid">
                      <Field
                        id="appName"
                        label="Product name"
                        error={errors.appName}
                      >
                        <input
                          {...inputProps("appName")}
                          maxLength={120}
                          placeholder="Your product name"
                        />
                      </Field>
                      <Field
                        id="appUrl"
                        label="Product URL"
                        error={errors.appUrl}
                      >
                        <input
                          {...inputProps("appUrl")}
                          type="url"
                          placeholder="https://your-product.com or App Store URL"
                        />
                      </Field>
                    </div>
                    <div className="ct-field">
                      <span className="ct-field-label">
                        Evidence{" "}
                        <span className="ct-required-star" aria-hidden="true">
                          *
                        </span>
                      </span>
                      <div
                        className="ct-checks"
                        id="evidenceTypes"
                        tabIndex={-1}
                      >
                        {(["image", "video"] as const).map((type) => (
                          <label key={type}>
                            <input
                              type="checkbox"
                              checked={draft.evidenceTypes.includes(type)}
                              onChange={(e) =>
                                update(
                                  "evidenceTypes",
                                  e.target.checked
                                    ? [...draft.evidenceTypes, type]
                                    : draft.evidenceTypes.filter(
                                        (t) => t !== type,
                                      ),
                                )
                              }
                            />
                            {type === "image"
                              ? "Screenshots"
                              : "Screen recordings"}
                          </label>
                        ))}
                      </div>
                      {errors.evidenceTypes && (
                        <p className="ct-error" role="alert">
                          {errors.evidenceTypes}
                        </p>
                      )}
                    </div>
                    <div className="ct-grid ct-budget-grid">
                      <Field
                        id="budget"
                        label="Total budget (USD)"
                        error={errors.budget}
                      >
                        <input
                          {...inputProps("budget")}
                          inputMode="decimal"
                          placeholder="0.00"
                        />
                      </Field>
                      <Field
                        id="reward"
                        label="Budget per review (USD)"
                        error={errors.reward}
                      >
                        <input
                          {...inputProps("reward")}
                          inputMode="decimal"
                          placeholder="0.00"
                        />
                      </Field>
                      <Field
                        id="deadline"
                        label={`Submission deadline${timezone ? ` (${timezone})` : ""}`}
                        error={errors.deadline}
                      >
                        <input
                          {...inputProps("deadline")}
                          type="datetime-local"
                        />
                      </Field>
                    </div>
                  </section>
                  <div className="ct-more-row">
                    <Button
                      type="button"
                      variant="ghost"
                      aria-expanded={more}
                      aria-controls="optional-fields"
                      onClick={() => setMore((value) => !value)}
                    >
                      {more ? "Less" : "More"}
                      <ChevronDown
                        size={15}
                        className={more ? "ct-chevron-open" : ""}
                      />
                    </Button>
                    <span className="ct-muted">
                      Optional details & questions
                    </span>
                  </div>
                  <div id="optional-fields" hidden={!more}>
                    <section className="ct-section">
                      <h2>Optional</h2>
                      <Field id="title" label="Task title" error={errors.title}>
                        <input
                          {...inputProps("title")}
                          maxLength={180}
                          placeholder="e.g. Try creating your first project"
                        />
                      </Field>
                      <Field
                        id="instructions"
                        label="Access instructions"
                        error={errors.instructions}
                      >
                        <textarea
                          {...inputProps("instructions")}
                          rows={2}
                          maxLength={5000}
                          placeholder="How should testers access or set up the product?"
                        />
                      </Field>
                      <Field
                        id="steps"
                        label="Steps to complete"
                        error={errors.steps}
                      >
                        <textarea
                          {...inputProps("steps")}
                          rows={3}
                          maxLength={10000}
                          placeholder={"One step per line"}
                        />
                      </Field>
                      <Field
                        id="evidenceInstructions"
                        label="What should the evidence show?"
                        error={errors.evidenceInstructions}
                      >
                        <textarea
                          {...inputProps("evidenceInstructions")}
                          rows={2}
                          maxLength={5000}
                          placeholder="Describe the screen, action, or blocker testers should capture."
                        />
                      </Field>
                      <div className="ct-grid">
                        <Field
                          id="minutes"
                          label="Estimated time (minutes)"
                          error={errors.minutes}
                        >
                          <input
                            {...inputProps("minutes")}
                            type="number"
                            min={1}
                            max={480}
                          />
                        </Field>
                      </div>
                    </section>{" "}
                    <section
                      className="ct-section"
                      id="questions"
                      tabIndex={-1}
                    >
                      <div className="ct-section-heading">
                        <h2>
                          Questions <span className="ct-muted">Optional</span>
                        </h2>
                        <span className="ct-muted">
                          Single choice · Reason required
                        </span>
                      </div>
                      {errors.questions && (
                        <p className="ct-error" role="alert">
                          {errors.questions}
                        </p>
                      )}
                      {draft.questions.map((q, index) => (
                        <div className="ct-question" key={q.id}>
                          <div className="ct-question-heading">
                            <label htmlFor={q.id}>Question {index + 1}</label>
                            <div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                disabled={index === 0}
                                aria-label={`Move question ${index + 1} up`}
                                onClick={() => moveQuestion(index, -1)}
                              >
                                <ArrowUp size={14} />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                disabled={index === draft.questions.length - 1}
                                aria-label={`Move question ${index + 1} down`}
                                onClick={() => moveQuestion(index, 1)}
                              >
                                <ArrowDown size={14} />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove question ${index + 1}`}
                                onClick={() =>
                                  update(
                                    "questions",
                                    draft.questions.filter(
                                      (item) => item.id !== q.id,
                                    ),
                                  )
                                }
                              >
                                <X size={15} />
                              </Button>
                            </div>
                          </div>
                          <input
                            id={q.id}
                            value={q.title}
                            maxLength={500}
                            aria-invalid={!!errors[q.id]}
                            aria-describedby={
                              errors[q.id] ? `${q.id}-error` : undefined
                            }
                            placeholder="What would you like to know?"
                            onChange={(e) =>
                              updateQuestion(q.id, (old) => ({
                                ...old,
                                title: e.target.value,
                              }))
                            }
                          />
                          <div className="ct-options">
                            {q.options.map((o, optionIndex) => (
                              <div className="ct-option" key={o.id}>
                                <span className="ct-radio" />
                                <input
                                  value={o.label}
                                  maxLength={200}
                                  aria-label={`Question ${index + 1}, option ${optionIndex + 1}`}
                                  placeholder={`Option ${optionIndex + 1}`}
                                  onChange={(e) =>
                                    updateQuestion(q.id, (old) => ({
                                      ...old,
                                      options: old.options.map((item) =>
                                        item.id === o.id
                                          ? { ...item, label: e.target.value }
                                          : item,
                                      ),
                                    }))
                                  }
                                />
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  disabled={optionIndex === 0}
                                  aria-label={`Move option ${optionIndex + 1} up in question ${index + 1}`}
                                  onClick={() => moveOption(q, optionIndex, -1)}
                                >
                                  <ArrowUp size={12} />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  disabled={q.options.length <= 2}
                                  aria-label={`Remove option ${optionIndex + 1} from question ${index + 1}`}
                                  onClick={() =>
                                    updateQuestion(q.id, (old) => ({
                                      ...old,
                                      options: old.options.filter(
                                        (item) => item.id !== o.id,
                                      ),
                                    }))
                                  }
                                >
                                  <X size={14} />
                                </Button>
                              </div>
                            ))}
                          </div>
                          {errors[q.id] && (
                            <p
                              id={`${q.id}-error`}
                              className="ct-error"
                              role="alert"
                            >
                              {errors[q.id]}
                            </p>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              updateQuestion(q.id, (old) => ({
                                ...old,
                                options: [
                                  ...old.options,
                                  { id: crypto.randomUUID(), label: "" },
                                ],
                              }))
                            }
                          >
                            <Plus size={14} />
                            Add option
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          update("questions", [
                            ...draft.questions,
                            {
                              id: crypto.randomUUID(),
                              title: "",
                              options: [
                                { id: crypto.randomUUID(), label: "" },
                                { id: crypto.randomUUID(), label: "" },
                              ],
                            },
                          ])
                        }
                      >
                        <Plus size={15} />
                        Add question
                      </Button>
                    </section>
                  </div>
                  <div className="ct-footer">
                    <span className="ct-muted">
                      Mock publishing · Saved on this device · No payment
                      collected
                    </span>
                    <Button type="submit">
                      {busy && <Loader2 size={15} className="ct-spin" />}Publish
                      demo task
                    </Button>
                  </div>
                </fieldset>
              </form>
            )}
          </>
        )}
      </main>
    </div>
  );
}
