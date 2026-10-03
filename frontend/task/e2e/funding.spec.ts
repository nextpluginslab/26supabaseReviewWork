import { test, expect } from "@playwright/test";
import { apiFixture, taskId } from "./api-fixture";

for (const width of [1440, 390]) {
  test(`funding balances and checkout at ${width}px`, async ({ page }) => {
    const fixture = await apiFixture(page);
    await page.setViewportSize({ width, height: 900 });
    const funded = {
      ...fixture.task(),
      config: {
        ...fixture.task().config,
        title: "Funded app",
        reward_amount_minor: 500,
        budget_amount_minor: 10000,
      },
    };
    const unpaid = {
      ...funded,
      id: "unpaid",
      status: "draft",
      config: {
        ...funded.config,
        title: "Unfunded app",
        budget_amount_minor: 50000,
      },
    };
    await page.route("**/functions/v1/api/v1/tasks?**", (route) =>
      route.fulfill({ json: { tasks: [funded, unpaid], next_cursor: null } }),
    );
    await page.route("**/payments/v1/tasks/*/funding", (route) =>
      route.fulfill({
        json: {
          funding_state: route.request().url().includes("/unpaid/")
            ? "unfunded"
            : "funded",
          budget_amount_minor: 10000,
          remaining_amount_minor: 7000,
          pending_amount_minor: 2000,
          paid_amount_minor: 1000,
        },
      }),
    );
    await page.route("**/payments/v1/tasks/unpaid/funding-sessions", (route) =>
      route.fulfill({
        json: { url: "https://checkout.stripe.com/c/pay/test" },
      }),
    );
    await page.route("https://checkout.stripe.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "Test checkout" }),
    );
    await page.goto("/funding");
    await expect(
      page
        .getByRole("navigation")
        .getByRole("link", { name: "Funding", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    const balances = page.getByRole("region", { name: "Funding balances" });
    await expect(balances).toContainText("$70.00");
    await expect(balances).toContainText("$20.00");
    await expect(balances).toContainText("$10.00");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/reviewwork-funding-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Fund with Stripe" }).click();
    await expect(page).toHaveURL("https://checkout.stripe.com/c/pay/test");
    await page.goto(`/tasks/${taskId}/results?funding=return`);
    await expect(page).toHaveURL(new RegExp("/funding#" + taskId));
  });
}
test("failed balance is unavailable, never a misleading zero", async ({
  page,
}) => {
  const fixture = await apiFixture(page);
  await page.route("**/functions/v1/api/v1/tasks?**", (route) =>
    route.fulfill({
      json: {
        tasks: [
          {
            ...fixture.task(),
            config: { ...fixture.task().config, reward_amount_minor: 500 },
          },
        ],
        next_cursor: null,
      },
    }),
  );
  await page.route("**/payments/v1/tasks/*/funding", (route) =>
    route.fulfill({ status: 503, json: { message: "Service unavailable" } }),
  );
  await page.goto("/funding");
  await expect(
    page.getByText("Some balances could not be loaded. Refresh to try again."),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Funding balances" }),
  ).not.toContainText("$0.00");
  await expect(
    page.getByRole("button", { name: "Fund with Stripe" }),
  ).toHaveCount(0);
});
