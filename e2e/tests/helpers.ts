import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const env = Object.fromEntries(readFileSync(join(process.cwd(), "e2e", ".env.test"), "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
export const PASSWORD = env.E2E_PASSWORD;
export const ACCOUNTS: Record<string, string> = JSON.parse(env.E2E_ACCOUNTS);

export type Problem = { where: string; kind: string; detail: string };

// Everything that goes wrong while the robot uses the app: crashes, script errors, refused server calls.
export function watch(page: Page, problems: Problem[], where: () => string) {
  page.on("pageerror", (error) => problems.push({ where: where(), kind: "erreur JS", detail: error.message }));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/Failed to load resource|favicon|DevTools|Download the React|shadow\*|pointerEvents|props\.pointerEvents|useNativeDriver/i.test(text)) return;
    problems.push({ where: where(), kind: "console", detail: text.slice(0, 400) });
  });
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("127.0.0.1:54321") || response.status() < 400) return;
    // 401 on refresh of a signed-out session and 406 on optional single rows are expected.
    if (response.status() === 406) return;
    let body = "";
    try { body = (await response.text()).slice(0, 300); } catch { /* ignored */ }
    problems.push({ where: where(), kind: `serveur ${response.status()}`, detail: `${url.replace(/^.*\/(rest|auth|storage)\/v1\//, "$1/")} ${body}` });
  });
}

export async function signIn(page: Page, account: string) {
  await page.goto("/");
  const inputs = page.locator("input");
  await expect(inputs.first()).toBeVisible();
  await inputs.nth(0).fill(ACCOUNTS[account] ?? account);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByText("SE CONNECTER", { exact: true }).click();
  await expect(page.getByLabel("Se déconnecter")).toBeVisible({ timeout: 30_000 });
}

export async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

export async function crashed(page: Page) {
  return page.getByText("Cet écran a rencontré un problème").first().isVisible().catch(() => false);
}
