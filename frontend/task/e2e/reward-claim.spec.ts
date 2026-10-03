import { expect, test } from "@playwright/test";
import { apiFixture } from "./api-fixture";
const rewardId = "60000000-0000-4000-8000-000000000001";
const claimPath = `/rewards/claim?reward=${rewardId}`;
function emailLink() {
  const enc = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  const token = `${enc({ alg: "HS256", typ: "JWT" })}.${
    enc({
      sub: "10000000-0000-4000-8000-000000000001",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      session_id: "email-session",
    })
  }.test`;
  return `${claimPath}#access_token=${token}&refresh_token=test-refresh&expires_in=3600&token_type=bearer&type=magiclink`;
}
for (const width of [1440, 390]) {
  test(`email link opens reward without a login screen at ${width}px`, async ({ page }) => {
    await apiFixture(page, { signedIn: false });
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/payments/v1/rewards/*/claim", (route) => {
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      return route.fulfill({
        json: {
          id: rewardId,
          amount_minor: 500,
          currency: "usd",
          state: "pending",
          ready: false,
        },
      });
    });
    await page.route(
      "**/payments/v1/rewards/*/claim/onboarding",
      (route) =>
        route.fulfill({
          json: { url: "https://connect.stripe.com/setup/test" },
        }),
    );
    await page.route(
      "https://connect.stripe.com/**",
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "Stripe receiving setup",
        }),
    );
    await page.goto(emailLink());
    await expect(page.getByText("$5.00", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Verify your email" }))
      .toHaveCount(0);
    await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Continue to Stripe" }).click();
    await expect(page).toHaveURL("https://connect.stripe.com/setup/test");
    // Same browser keeps the email proof on returning from Stripe.
    await page.route(
      "**/payments/v1/rewards/*/claim",
      (route) =>
        route.fulfill({
          json: {
            id: rewardId,
            amount_minor: 500,
            currency: "usd",
            state: "paid",
            ready: true,
          },
        }),
    );
    await page.goto(`${claimPath}&connect=return`);
    await expect(page.getByRole("heading", { name: "Test payment completed" }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to Stripe" }))
      .toHaveCount(0);
  });
}
test("expired link can request email verification without registration", async ({ page }) => {
  await apiFixture(page, { signedIn: false });
  await page.route("**/auth/v1/otp**", (route) => {
    const body = route.request().postDataJSON();
    expect(body.email).toBe("tester@example.com");
    expect(body.create_user).toBe(true);
    expect(new URL(route.request().url()).searchParams.get("redirect_to"))
      .toContain(claimPath);
    return route.fulfill({ json: {} });
  });
  await page.goto(
    `${claimPath}#error=access_denied&error_code=otp_expired&error_description=Link+expired`,
  );
  await expect(page.getByRole("heading", { name: "Verify your email" }))
    .toBeVisible();
  await page.getByLabel("Email address").fill("tester@example.com");
  await page.getByRole("button", { name: "Send secure link" }).click();
  await expect(page.getByLabel("Email code")).toBeVisible();
});
test("wrong recipient cannot see the reward and can verify another email", async ({ page }) => {
  await apiFixture(page);
  await page.route(
    "**/payments/v1/rewards/*/claim",
    (route) =>
      route.fulfill({
        status: 404,
        json: {
          code: "reward_not_found",
          message: "This reward belongs to a different email address.",
        },
      }),
  );
  await page.goto(claimPath);
  await expect(page.getByRole("heading", { name: "Verify your email" }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to Stripe" }))
    .toHaveCount(0);
});
