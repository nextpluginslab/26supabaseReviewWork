import { expect, test } from "@playwright/test";
test("developer can inspect, sign in, confirm once and persist the result", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/tasks/e2e/results");
  await expect(
    page.getByRole("heading", { name: "Results", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Developer login" })).toHaveCSS(
    "border-radius",
    "8px",
  );
  await page.screenshot({
    path: "/tmp/fieldwork-results-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("combobox", { name: "Question to show" })
    .selectOption("clarity");
  await expect(page.getByText("Yes, always", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Alex Morgan/ }).click();
  await expect(
    page.getByRole("heading", { name: "Answers & reasons" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Workspace screenshot" }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace screenshot" }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Close dialog" })
    .click();
  await page.getByRole("button", { name: "Sign in to confirm" }).click();
  await page
    .getByRole("textbox", { name: "Email address" })
    .fill("developer@example.com");
  await page.getByRole("button", { name: "Continue to demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm this feedback?" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm & simulate $10 payment" })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Paid · simulated", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.locator(".remaining-budget")).toContainText("$70");
  await page.reload();
  await expect(page.locator(".remaining-budget")).toContainText("$70");
  await page
    .getByRole("textbox", { name: "Search submissions" })
    .fill("not-a-person");
  await expect(
    page.getByRole("heading", { name: "No matching submissions" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Page 2 of 3")).toBeVisible();
  expect(errors).toEqual([]);
});
test("mobile layout and submission deep links work", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tasks/mobile/results");
  await expect(
    page.getByRole("heading", { name: "Results", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/fieldwork-results-mobile.png",
    fullPage: true,
  });
  await page.goto("/tasks/mobile/results?submission=FB-006");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByText("AI summary is unavailable.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in to confirm" }),
  ).toBeEnabled();
});
