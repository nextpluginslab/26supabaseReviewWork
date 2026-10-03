import type { Submission } from "./types";

export function Confidence(
  { ai, compact = false }: { ai: Submission["ai"]; compact?: boolean },
) {
  const score = ai.confidenceScore;
  const valid = ai.status === "ready" && typeof score === "number" &&
    Number.isInteger(score) && score >= 0 && score <= 10;
  if (!valid) {
    return (
      <div className="confidence-unavailable">
        {ai.status === "generating"
          ? "AI assessment pending"
          : ai.status === "failed"
          ? "AI assessment unavailable"
          : "Not scored · earlier review"}
      </div>
    );
  }
  const level = score <= 4 ? "low" : score <= 7 ? "medium" : "high";
  const label = score <= 4
    ? "Insufficient evidence"
    : score <= 7
    ? "Partial support"
    : "Strong support";
  return (
    <div
      className={`confidence confidence-${level}${
        compact ? " confidence-compact" : ""
      }`}
    >
      <div className="confidence-heading">
        <span>AI confidence</span>
        <strong>
          {score}
          <small>/ 10</small>
        </strong>
      </div>
      <div
        className="confidence-track"
        role="progressbar"
        aria-label="AI evidence confidence"
        aria-valuemin={0}
        aria-valuemax={10}
        aria-valuenow={score}
        aria-valuetext={`${score} out of 10: ${label}`}
      >
        <div style={{ width: `${score * 10}%` }} />
      </div>
      <b>{label}</b>
      {!compact && (
        <>
          <p>{ai.confidenceReason}</p>
          <small>
            How well the evidence supports a relevant testing experience.
            Publisher makes the final decision.
          </small>
        </>
      )}
    </div>
  );
}
