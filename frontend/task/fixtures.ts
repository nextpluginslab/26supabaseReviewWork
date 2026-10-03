import type { Task } from "./types";
// Example publisher configuration only. The page renders any Task contract.
export function taskFixture(id: string): Task {
  return {
    id,
    title: "Test your first focus session",
    appName: "Focus Garden",
    publisher: "Focus Garden team",
    appUrl: "https://pomofocus.io",
    appType: id === "mobile" ? "ios" : "web",
    minutes: 15,
    description:
      "Try planning a focused work session and share your experience.",
    instructions: "Open the app, then return here to submit your feedback.",
    steps: [
      "Explore the home screen and find where to start a focus session.",
      "Create a task you’d like to work on, then start a timer.",
      "Try pausing or ending your session. Notice what feels clear—or confusing.",
    ],
    evidenceInstructions:
      "Share a screenshot or short recording of your task and focus session. If you got stuck, show us where it happened instead.",
    evidenceTypes: ["image", "video"],
    reward: 1200,
    deadline:
      id === "expired" ? "2020-01-01T23:59:00Z" : "2027-10-15T23:59:00Z",
    timezone: "America/Phoenix",
    questions: [
      {
        id: "first-session",
        title: "How easy was it to start your first focus session?",
        options: [
          { id: "easy", label: "Easy" },
          { id: "some-effort", label: "Took some effort" },
          { id: "stuck", label: "I got stuck" },
        ],
      },
      {
        id: "use-again",
        title: "Would you use this for your next work session?",
        options: [
          { id: "yes", label: "Yes, I would" },
          { id: "maybe", label: "Maybe" },
          { id: "no", label: "Probably not" },
        ],
      },
      {
        id: "willing-to-pay",
        title: "Would you be willing to pay $5 per month?",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
          { id: "unsure", label: "Not sure" },
        ],
      },
    ],
  };
}
