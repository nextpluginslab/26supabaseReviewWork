import { test, expect } from "@playwright/test";
import { apiFixture } from "./api-fixture";

for (const width of [1440, 390]) {
  test(`auth layout and email flow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await apiFixture(page, { signedIn: false });
    await page.route("**/auth/v1/otp**", (route) =>
      route.fulfill({ json: {} }),
    );
    await page.route("**/auth/v1/verify", (route) =>
      route.fulfill({
        status: 403,
        json: { msg: "Code expired. Please try again." },
      }),
    );
    await page.goto("/tasks/new");
    await expect(
      page.getByRole("heading", { name: "Sign in to reviewWork" }),
    ).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(1);
    await page.screenshot({ path: `/tmp/reviewwork-login-${width}.png` });
    await page.getByLabel("Email", { exact: true }).fill("tester@example.com");
    await page
      .getByRole("button", { name: "Email me a sign-in link / code" })
      .click();
    await expect(page.getByLabel("Email code")).toBeVisible();
    await page.getByLabel("Email code").fill("123456");
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(page.locator(".account-error")).toContainText("Code expired");
    await page
      .getByRole("button", { name: "Use another email / resend" })
      .click();
    await expect(page.getByLabel("Email", { exact: true })).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`signed-in navbar and sign-out at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await apiFixture(page);
    await page.route("**/auth/v1/logout**", (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.goto("/tasks/new");
    const header = page.getByRole("banner");
    await expect(header).toHaveCount(1);
    await expect(header.getByText("tester@example.com")).toBeVisible();
    await expect(
      header.getByRole("link", { name: "Create task" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("button", { name: "Publish task", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `/tmp/reviewwork-navbar-${width}.png` });
    await header.getByRole("button", { name: "Sign out" }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in to reviewWork" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Publish task", exact: true }),
    ).toHaveCount(0);
  });
}

test("test account uses password auth while other emails keep OTP", async ({
  page,
}) => {
  await apiFixture(page, { signedIn: false });
  let passwordRequests = 0;
  await page.route("**/auth/v1/token**", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("grant_type")).toBe(
      "password",
    );
    expect(route.request().postDataJSON()).toMatchObject({
      email: "test@test.com",
      password: "wrong-password",
    });
    passwordRequests++;
    await route.fulfill({
      status: 400,
      json: { msg: "Invalid login credentials" },
    });
  });
  await page.goto("/tasks/new");
  await page.getByLabel("Email", { exact: true }).fill("test@test.com");
  await expect(page.getByLabel("Test account password")).toBeVisible();
  await page.getByLabel("Test account password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".account-error")).toContainText(
    "Invalid login credentials",
  );
  expect(passwordRequests).toBe(1);
  await expect(
    page.getByRole("button", { name: "Publish task", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill("another@example.com");
  await expect(page.getByLabel("Test account password")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Email me a sign-in link / code" }),
  ).toBeVisible();
});
