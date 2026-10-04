import { test, expect } from "@playwright/test";
import { apiFixture, slug } from "./api-fixture";
test("publisher creates a real API task with zero questions and shares the slug link", async ({
  page,
}) => {
  const fixture = await apiFixture(page);
  await page.goto("/tasks/new");
  await expect(
    page.getByRole("heading", { name: "Create task", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Total budget (USD)")).toHaveValue("0");
  await expect(page.getByLabel("Budget per review (USD)")).toHaveValue("0");
  await expect(page.getByLabel("Task title", { exact: true })).toBeHidden();
  await page.getByLabel("Product name", { exact: true }).fill("Notebook");
  await page
    .getByLabel("Product URL", { exact: true })
    .fill("https://example.com");
  await page.getByRole("button", { name: "Publish task", exact: true }).click();
  await expect(page.getByText("Task published", { exact: true })).toBeVisible();
  const url = await page
    .getByLabel("Tester page", { exact: true })
    .inputValue();
  expect(url).toContain(slug);
  const create = fixture.calls.find(
    (c) => c.path.endsWith("/tasks") && c.method === "POST",
  );
  expect(create?.body.config.questions).toEqual([]);
  expect(create?.key).toBeTruthy();
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "Notebook", exact: true }),
  ).toBeVisible();
});
test("creation requires real sign-in; public task remains readable", async ({
  page,
}) => {
  await apiFixture(page, { signedIn: false });
  await page.goto("/tasks/new");
  await expect(
    page.getByRole("button", { name: "Email me a sign-in link / code" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish task", exact: true }),
  ).toHaveCount(0);
  await page.goto(`/tasks/${slug}`);
  await expect(
    page.getByRole("heading", { name: "Test product", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Upload evidence files")).toBeDisabled();
});
test("required and optional creation fields fit mobile and retain draft", async ({
  page,
}) => {
  await apiFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tasks/new");
  await expect(
    page.getByRole("button", { name: "Publish task", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByLabel("Task title", { exact: true }).fill("Saved title");
  await page.waitForTimeout(600);
  await page.reload();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByLabel("Task title", { exact: true })).toHaveValue(
    "Saved title",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("paid creation leads to funding and can publish the saved draft", async ({ page }) => {
  const fixture = await apiFixture(page);
  let funded = false;
  await page.route("**/api/v1/tasks/*/publish", async (route) => {
    if (funded) return route.fallback();
    return route.fulfill({
      status: 409,
      json: { error: { code: "funding_required", message: "Complete funding first." } },
    });
  });
  await page.route("**/payments/v1/tasks/*/funding", (route) => route.fulfill({
    json: {
      funding_state: funded ? "funded" : "unfunded",
      budget_amount_minor: 5000,
      remaining_amount_minor: funded ? 5000 : 0,
      pending_amount_minor: 0,
      paid_amount_minor: 0,
    },
  }));
  await page.goto("/tasks/new");
  await page.getByLabel("Product name", { exact: true }).fill("Paid notebook");
  await page.getByLabel("Product URL", { exact: true }).fill("https://example.com");
  await page.getByLabel("Total budget (USD)").fill("50");
  await page.getByLabel("Budget per review (USD)").fill("5");
  await page.getByRole("button", { name: "Publish task", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/funding#${fixture.task().id}$`));
  await expect(page.getByRole("button", { name: "Fund with Stripe" })).toBeVisible();
  funded = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Publish task", exact: true }).click();
  await expect(page.locator(".funding-task-title")).toContainText("published");
  await page.reload();
  await expect(page.locator(".funding-task-title")).toContainText("published");
  expect(fixture.calls.filter((c) => c.path.endsWith("/tasks") && c.method === "POST")).toHaveLength(1);
});
