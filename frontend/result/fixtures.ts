import type { Results, ReviewStatus, PaymentStatus } from "./types";
// Sample content lives in the mock adapter, never in the page or chart components.
export function createFixture(taskId: string): Results {
  const people = [
    "Alex Morgan",
    "Jamie Chen",
    "Sam Rivera",
    "Taylor Brooks",
    "Jordan Lee",
    "Casey Wilson",
    "Riley Patel",
    "Morgan Park",
    "Avery Kim",
    "Quinn Davis",
    "Drew Martin",
    "Robin Ellis",
  ];
  const choices = [
    [0, 1, 0],
    [1, 1, 1],
    [0, 0, 0],
    [2, 2, 1],
    [0, 0, 0],
    [1, 1, 2],
    [0, 0, 0],
    [0, 1, 0],
    [1, 0, 1],
    [0, 0, 0],
    [0, 1, 0],
    [2, 2, 2],
  ];
  const experience = [
    "The workspace felt familiar right away. I created my first project without checking the help docs.",
    "Getting started was smooth, but I had to look around to find the invite button.",
    "A clean, focused experience. The sample project helped me understand what to do next.",
    "I got stuck at the team setup step. The invitation screen did not explain whether I could skip it.",
    "Everything I needed was in one place. I especially liked the project checklist.",
    "The setup worked, but the labels in team settings could be clearer.",
  ];
  const statuses: ReviewStatus[] = [
    "awaiting_publisher",
    "awaiting_publisher",
    "awaiting_publisher",
    "changes_requested",
    "awaiting_publisher",
    "awaiting_publisher",
    "awaiting_publisher",
    "accepted",
    "accepted",
    "accepted",
    "accepted",
    "declined",
  ];
  const payments: PaymentStatus[] = statuses.map((s, i) =>
    s === "accepted"
      ? i === 10
        ? "pending"
        : "paid"
      : s === "declined"
        ? "not_payable"
        : "awaiting_confirmation",
  );
  return {
    task: {
      id: taskId,
      title: "First impressions & onboarding",
      product: "Forma",
      description:
        "Explore the workspace, create your first project, and invite a teammate. Share what felt intuitive and where you got stuck.",
      reward: 1000,
      budget: 12000,
      deadline: "2026-10-10T23:59:00Z",
      questions: [
        {
          id: "ease",
          text: "How easy was it to get started?",
          options: [
            { id: "easy", label: "Easy & intuitive" },
            { id: "some-effort", label: "Took some effort" },
            { id: "difficult", label: "Difficult" },
          ],
        },
        {
          id: "clarity",
          text: "Was the next step always clear?",
          options: [
            { id: "yes", label: "Yes, always" },
            { id: "mostly", label: "Most of the time" },
            { id: "no", label: "Not really" },
          ],
        },
        {
          id: "return",
          text: "Would you use this product again?",
          options: [
            { id: "yes", label: "Yes" },
            { id: "maybe", label: "Maybe" },
            { id: "no", label: "No" },
          ],
        },
      ],
    },
    submissions: people.map((name, i) => ({
      id: `FB-${String(i + 1).padStart(3, "0")}`,
      name,
      initials: name
        .split(" ")
        .map((n) => n[0])
        .join(""),
      color: ["sage", "lilac", "peach", "blue"][i % 4],
      submittedAt: `2026-10-03T${String(20 - Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "05" : "42"}:00Z`,
      status: statuses[i],
      payment: payments[i],
      summary: experience[i % 6],
      answers: [
        {
          questionId: "ease",
          optionId: ["easy", "some-effort", "difficult"][choices[i][0]],
          reason: experience[i % 6],
        },
        {
          questionId: "clarity",
          optionId: ["yes", "mostly", "no"][choices[i][1]],
          reason:
            choices[i][1] === 0
              ? "The checklist gave me a clear sequence to follow, from creating a project to adding a teammate."
              : "The team invitation step could use a short explanation and a more visible skip option.",
        },
        {
          questionId: "return",
          optionId: ["yes", "maybe", "no"][choices[i][2]],
          reason:
            choices[i][2] === 0
              ? "It fits the way I organize small projects. I would try it with my team."
              : "I would want a clearer setup flow before making it part of my routine.",
        },
      ],
      evidence: [
        {
          name: "Workspace screenshot",
          url: "/evidence/workspace.svg",
          type: "image" as const,
        },
      ],
      ai: {
        confidenceScore: i === 2 || i === 5 || i === 4 ? undefined : [9, 6, 0, 1][i % 4],
        confidenceReason: "The screenshot supports part of the experience; review the required steps before deciding.",
        status: i === 2 ? "generating" : i === 5 ? "failed" : "ready",
        note:
          choices[i][0] === 2
            ? "The participant describes a blocker at team setup. The screenshot alone cannot confirm the full invitation flow. Review the original answer before deciding."
            : "The screenshot shows a created project and supports the written feedback. Completion of the invitation step cannot be verified from this image alone.",
      },
      reviewReason:
        statuses[i] === "changes_requested"
          ? "Please add a screenshot of the invitation screen where you got stuck."
          : statuses[i] === "declined"
            ? "The submitted image does not show the product being tested."
            : statuses[i] === "accepted"
              ? "Reviewed the original answers and screenshot; the feedback provides a useful account of the experience."
              : undefined,
    })),
    summary: [
      {
        title: "A strong first impression",
        text: "7 of 12 participants found it easy to get started. The familiar workspace and project checklist helped people find their footing.",
        sources: ["FB-001", "FB-003", "FB-005"],
      },
      {
        title: "Team setup needs a little clarity",
        text: "7 participants were not always sure what to do next. Feedback points to invitation labels and the option to skip team setup.",
        sources: ["FB-002", "FB-004", "FB-006"],
      },
      {
        title: "A reason to come back",
        text: "7 participants would use the product again. Others want a smoother setup before bringing it into their routine.",
        sources: ["FB-007", "FB-008", "FB-010"],
      },
    ],
    asOf: "2026-10-03T21:00:00Z",
  };
}
