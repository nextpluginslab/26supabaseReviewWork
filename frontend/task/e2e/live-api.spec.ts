import { test, expect } from "@playwright/test";
import { apiFixture, slug, taskId } from "./api-fixture";
test("signed upload, formal submission, requested revision preserve identity and concurrency tokens", async ({
  page,
}) => {
  const f = await apiFixture(page);
  await page.goto(`/tasks/${slug}`);
  await expect(
    page.getByRole("heading", { name: "Test product", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Upload evidence files")
    .setInputFiles({
      name: "proof.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await expect(
    page.getByText("Uploaded securely", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Submit feedback", exact: true })
    .click();
  await expect(page.getByText("FW-LIVE", { exact: false })).toBeVisible();
  f.requestChanges();
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Please add details")).toBeVisible();
  await page
    .getByRole("button", {
      name: /Submit.*(update|revision|supplement)|Submit updated feedback|Submit supplement/i,
    })
    .click();
  await expect(
    page.getByText("Awaiting publisher confirmation", { exact: true }),
  ).toBeVisible();
  expect(f.row.revisions).toHaveLength(2);
  expect(
    f.calls.find((c) => c.path.endsWith("/revisions"))?.body.expected_version,
  ).toBe(2);
});
test("publisher requests information with actual revision and reason, without auto acceptance", async ({
  page,
}) => {
  const f = await apiFixture(page, { submitted: true });
  await page.goto(`/tasks/${taskId}/results?submission=FW-LIVE`);
  await expect(
    page.getByRole("heading", { name: "Answers & reasons" }),
  ).toBeVisible();
  await expect(
    page.getByText("Useful feedback", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Review reason").fill("Please show the editor");
  await page
    .getByRole("button", { name: "Request more information", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.row.processing_status).toBe("changes_requested");
  expect(f.calls.find((c) => c.path.endsWith("/decisions"))?.body.reason).toBe(
    "Please show the editor",
  );
});
test("settings uses API key lifecycle and notification read API", async ({
  page,
}) => {
  const f = await apiFixture(page);
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Notifications (1 unread)" }),
  ).toBeVisible();
  await page.getByLabel("Key name").fill("Agent");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  await expect(
    page.getByText("rwk_fake_e2e_key", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByText("rwk_fake_e2e_key", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Notifications (0 unread)" }),
  ).toBeVisible();
  expect(f.calls.some((c) => c.method === "DELETE")).toBe(true);
});

test("public task allows a fresh guest to upload and submit without login or email verification", async ({ page }) => {
  const f = await apiFixture(page, { signedIn: false });
  let guestStarts = 0;
  await page.route("**/auth/v1/signup", async route => {
    guestStarts++;
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const user = { id: "10000000-0000-4000-8000-000000000001", is_anonymous: true, email: "", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    await route.fulfill({ json: { user, access_token: `${enc({alg:"HS256"})}.${enc({sub:user.id,role:"authenticated",is_anonymous:true,exp:Math.floor(Date.now()/1000)+3600})}.test`, refresh_token: "guest-refresh", expires_in: 3600, token_type: "bearer" } });
  });
  await page.goto(`/tasks/${slug}`);
  await expect(page.getByRole("heading", { name: "Test product", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in|send.*code|verify email/i })).toHaveCount(0);
  expect(guestStarts).toBe(0);
  await page.getByLabel("Your email address").fill("guest@example.com");
  await page.getByLabel("Upload evidence files").setInputFiles({ name:"proof.png",mimeType:"image/png",buffer:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=","base64") });
  await expect(page.getByText("Uploaded securely", { exact:false })).toBeVisible();
  await page.getByRole("button", { name:"Submit feedback",exact:true }).click();
  await expect(page.getByText("FW-LIVE", { exact:false })).toBeVisible();
  expect(guestStarts).toBe(1);
  expect(f.calls.find(c => c.method === "POST" && c.path.endsWith("/submissions"))?.body.contact_email).toBe("guest@example.com");
});
