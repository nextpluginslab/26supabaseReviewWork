import { test, expect } from "@playwright/test";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=",
  "base64",
);
async function upload(page: import("@playwright/test").Page) {
  await page.getByLabel("Upload evidence files").setInputFiles({
    name: "experience.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(
    page.getByText("Saved locally", { exact: false }).first(),
  ).toBeVisible();
}
async function verify(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Verify email" }).click();
  await page.getByLabel("Verification code").fill("123456");
  await page.getByRole("button", { name: "Confirm code" }).click();
  await expect(
    page.getByRole("button", { name: "Verified", exact: true }),
  ).toBeDisabled();
}
test("submit, restore, request changes and preserve revision history", async ({
  page,
}) => {
  const exceptions: string[] = [];
  page.on("pageerror", (e) => exceptions.push(e.message));
  await page.goto("/tasks/demo?preview=1");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Test your first focus session",
  );
  await page
    .getByRole("button", { name: "Submit feedback", exact: true })
    .click();
  await expect(
    page.getByText("Add at least one screenshot", { exact: false }),
  ).toBeVisible();
  await upload(page);
  await page.getByRole("radio", { name: "I got stuck", exact: true }).click();
  await page
    .locator("#reason-first-session")
    .fill("I could not find the pause control.");
  await page.getByRole("radio", { name: "Probably not", exact: true }).click();
  await page
    .locator("#reason-use-again")
    .fill("I need a clearer way to pause.");
  await page.getByRole("radio", { name: "No", exact: true }).click();
  await page
    .locator("#reason-willing-to-pay")
    .fill("I would need clearer controls before paying $5 per month.");
  await page.getByLabel("Your email address").fill("tester@example.com");
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator("#reason-first-session")).toHaveValue(
    "I could not find the pause control.",
  );
  await expect(
    page.getByText("Saved locally", { exact: false }).first(),
  ).toBeVisible();
  await verify(page);
  await page
    .getByRole("button", { name: "Submit feedback", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Awaiting publisher confirmation" }),
  ).toBeVisible();
  const id = await page.locator(".fw-review-top .fw-eyebrow").textContent();
  await page.getByText("Mock preview controls", { exact: true }).click();
  await page
    .getByLabel("Simulate publisher review")
    .selectOption("changes_requested:awaiting_confirmation");
  await expect(
    page.getByRole("heading", { name: "More information requested" }),
  ).toBeVisible();
  await page
    .locator("#reason-first-session")
    .fill("Updated: the pause control was hidden below the fold.");
  await page.getByRole("button", { name: "Submit updated feedback" }).click();
  await expect(
    page.getByRole("heading", { name: "Awaiting publisher confirmation" }),
  ).toBeVisible();
  await expect(page.locator(".fw-review-top .fw-eyebrow")).toHaveText(
    id!.replace("REVISION 1", "REVISION 2"),
  );
  await page.getByText("Submission history", { exact: true }).click();
  await expect(page.getByText("Revision 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Revision 2", { exact: true })).toBeVisible();
  await page
    .getByLabel("Simulate publisher review")
    .selectOption("accepted:failed");
  await expect(
    page.getByRole("heading", { name: "Feedback accepted" }),
  ).toBeVisible();
  await expect(
    page.getByText("Payment failed · Publisher can retry", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Feedback accepted" }),
  ).toBeVisible();
  expect(exceptions).toEqual([]);
});
test("mobile, deadline, invalid upload and missing task", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tasks/demo");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Test your first focus session",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/fieldwork-task-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("Upload evidence files").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("text"),
  });
  await expect(
    page.getByText("notes.txt: Use a supported screenshot", { exact: false }),
  ).toBeVisible();
  await page.goto("/tasks/expired");
  await expect(
    page.getByRole("button", { name: "Submit feedback", exact: true }),
  ).toBeDisabled();
  await page.goto("/tasks/missing");
  await expect(
    page.getByRole("heading", { name: "Task unavailable" }),
  ).toBeVisible();
});
test("desktop preview and upload retry when offline", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto("/tasks/demo");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Test your first focus session",
  );
  await page.screenshot({
    path: "/tmp/fieldwork-task-desktop.png",
    fullPage: true,
  });
  await context.setOffline(true);
  await page.getByLabel("Upload evidence files").setInputFiles({
    name: "experience.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(
    page.getByText("You’re offline. Reconnect and try again."),
  ).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByText("Saved locally", { exact: false }).first(),
  ).toBeVisible();
});
