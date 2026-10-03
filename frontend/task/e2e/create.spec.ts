import { test, expect } from "@playwright/test";
test("publisher creates a task and opens its actual tester and results pages", async ({
  page,
}) => {
  await page.goto("/tasks/new");
  await expect(
    page.getByRole("heading", { name: "Create task", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish demo task" }).click();
  await expect(page.getByText("This field is required.").first()).toBeVisible();
  await page.getByLabel("Product name", { exact: true }).fill("Notebook");
  await page.getByLabel("Product URL").fill("https://example.com");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Create your first note");
  await page.getByLabel("Access instructions").fill("Open the web app.");
  await page.getByLabel("Steps to complete").fill("Create a note\nRename it");
  await page
    .getByLabel("What should the evidence show?")
    .fill("A screenshot of your note.");
  await page.getByLabel("Screen recordings", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  await page
    .getByLabel("Question 1", { exact: true })
    .fill("Was renaming clear?");
  await page.getByLabel("Question 1, option 1", { exact: true }).fill("Clear");
  await page
    .getByLabel("Question 1, option 2", { exact: true })
    .fill("Confusing");
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  await page
    .getByLabel("Question 2", { exact: true })
    .fill("Would you use it?");
  await page.getByLabel("Question 2, option 1", { exact: true }).fill("Yes");
  await page.getByLabel("Question 2, option 2", { exact: true }).fill("No");
  await page
    .getByRole("button", { name: "Move question 2 up", exact: true })
    .click();
  await expect(page.getByLabel("Question 1", { exact: true })).toHaveValue(
    "Would you use it?",
  );
  await page.getByLabel("Budget per review (USD)").fill("5.25");
  await page.getByLabel("Total budget (USD)").fill("21");
  await page
    .getByLabel("Submission deadline", { exact: false })
    .fill("2099-01-01T12:00");
  await page.waitForTimeout(600);
  await page.reload();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByLabel("Task title", { exact: true })).toHaveValue(
    "Create your first note",
  );
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Create your first note" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish demo task" }).click();
  await expect(page.getByText("Demo published", { exact: true })).toBeVisible();
  const testUrl = await page
    .getByLabel("Tester page", { exact: true })
    .inputValue();
  const resultsUrl = await page
    .getByLabel("Results page", { exact: true })
    .inputValue();
  await page.goto(testUrl);
  await expect(
    page.getByRole("heading", { name: "Create your first note" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Confusing", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Upload evidence files")).toHaveAttribute(
    "accept",
    "image/png,image/jpeg,image/webp",
  );
  await page.goto(resultsUrl);
  await expect(
    page.getByText("Create your first note", { exact: true }).first(),
  ).toBeVisible();
});
test("minimal creation page fits mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tasks/new");
  await expect(
    page.getByRole("button", { name: "Publish demo task" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/reviewwork-create-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Publish demo task" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/reviewwork-create-desktop.png",
    fullPage: true,
  });
});

test("only required fields can publish an App Store task", async ({ page }) => {
  await page.goto("/tasks/new");
  await expect(page.getByLabel("Platform", { exact: true })).toHaveCount(0);
  await page.getByLabel("Product name", { exact: true }).fill("Minimal app");
  await page
    .getByLabel("Product URL", { exact: true })
    .fill("https://apps.apple.com/app/id123456");
  await expect(page.getByLabel("Screenshots", { exact: true })).toBeChecked();
  await expect(
    page.getByLabel("Screen recordings", { exact: true }),
  ).toBeChecked();
  await page.getByLabel("Total budget (USD)").fill("20");
  await page.getByLabel("Budget per review (USD)").fill("5");
  await page
    .getByLabel("Submission deadline", { exact: false })
    .fill("2099-01-01T12:00");
  await page.getByRole("button", { name: "Publish demo task" }).click();
  await expect(page.getByText("Demo published", { exact: true })).toBeVisible();
  const url = await page
    .getByLabel("Tester page", { exact: true })
    .inputValue();
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "Minimal app", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Get app" })).toHaveAttribute(
    "href",
    "https://apps.apple.com/app/id123456",
  );
  await expect(
    page.getByRole("heading", { name: "Questions", exact: true }),
  ).toHaveCount(0);
});

test("defaults, optional disclosure and amber validation", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-03T12:00:00Z"));
  await page.goto("/tasks/new");
  const more = page.getByRole("button", { name: "More", exact: true });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Total budget (USD)")).toHaveValue("0");
  expect(
    await page
      .locator(".ct-budget-grid input")
      .evaluateAll((nodes) => nodes.map((node) => node.id)),
  ).toEqual(["budget", "reward", "deadline"]);
  await expect(page.getByLabel("Task title", { exact: true })).toBeHidden();
  await expect(page.getByLabel("Budget per review (USD)")).toHaveValue("0");
  const expected = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() + 3);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  });
  await expect(
    page.getByLabel("Submission deadline", { exact: false }),
  ).toHaveValue(expected);
  await page.getByRole("button", { name: "Publish demo task" }).click();
  await expect(page.getByText("This field is required.")).toHaveCSS(
    "color",
    "rgb(180, 83, 9)",
  );
  await more.click();
  await expect(page.getByLabel("Task title", { exact: true })).toBeVisible();
  await expect(page.locator(".ct-question")).toHaveCount(0);
  await page.getByLabel("Task title", { exact: true }).fill("My draft title");
  await page.getByRole("button", { name: "Less", exact: true }).click();
  await more.click();
  await expect(page.getByLabel("Task title", { exact: true })).toHaveValue(
    "My draft title",
  );
  await page
    .getByLabel("Product name", { exact: true })
    .fill("Default product");
  await page
    .getByLabel("Product URL", { exact: true })
    .fill("https://example.com");
  await page.getByLabel("Estimated time (minutes)").fill("0");
  await page.getByRole("button", { name: "Less", exact: true }).click();
  await page.getByRole("button", { name: "Publish demo task" }).click();
  await expect(page.getByLabel("Estimated time (minutes)")).toBeVisible();
  await expect(page.getByLabel("Estimated time (minutes)")).toBeFocused();
});
