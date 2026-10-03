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
