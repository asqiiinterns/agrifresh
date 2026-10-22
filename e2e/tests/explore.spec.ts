// For each role: open every tab, every sheet of a screen and every menu entry (two levels deep),
// and record what breaks (crash card, script error, refused server call). Nothing is created or deleted:
// only navigation (menu entries and sheets).
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNTS, crashed, settle, signIn, watch, type Problem } from "./helpers";

const report: Record<string, { visited: string[]; problems: Problem[] }> = {};

async function topTargets(page: Page) {
  const ids = await page.locator('[data-testid^="bar-"], [data-testid^="top-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? ""));
  return [...new Set(ids)].filter(Boolean);
}

async function rowTitles(page: Page) {
  return page.locator('[data-testid="menu-row"]:visible').evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? "").trim().slice(0, 60)));
}

async function sheetTitles(page: Page) {
  return page.locator('[data-testid="sheet-tab"]:visible').evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? "").trim()));
}

for (const role of Object.keys(ACCOUNTS)) {
  test(`explorer tous les écrans : ${role}`, async ({ page }) => {
    test.setTimeout(30 * 60_000);
    const problems: Problem[] = [];
    const visited: string[] = [];
    let where = "connexion";
    watch(page, problems, () => where);
    await signIn(page, role);
    await settle(page);

    const check = async (label: string) => {
      where = label;
      await settle(page);
      visited.push(label);
      if (await crashed(page)) {
        const detail = await page.getByText(/ · \w*Error: |Error: /).first().textContent().catch(() => "");
        problems.push({ where: label, kind: "écran planté", detail: detail ?? "" });
        await page.screenshot({ path: join("e2e", "results", `crash-${role}-${visited.length}.png`) }).catch(() => undefined);
      }
    };
    // Back to a known state: reload, then open the top-level entry.
    const open = async (target: string) => {
      await page.goto("/");
      await page.getByLabel("Se déconnecter").waitFor({ timeout: 30_000 });
      await page.getByTestId(target).first().click();
    };
    const clickNth = async (selector: string, index: number) => {
      const node = page.locator(`${selector}:visible`).nth(index);
      if (!(await node.count())) return false;
      await node.scrollIntoViewIfNeeded().catch(() => undefined);
      await node.click({ timeout: 5_000 }).catch(() => undefined);
      return true;
    };

    for (const target of await topTargets(page)) {
      await open(target);
      await check(target);
      for (const [index, sheet] of (await sheetTitles(page)).entries()) {
        await open(target);
        await clickNth('[data-testid="sheet-tab"]', index);
        await check(`${target} › ${sheet}`);
      }
      const rows = await rowTitles(page);
      for (const [index, row] of rows.entries()) {
        await open(target);
        await settle(page);
        if (!(await clickNth('[data-testid="menu-row"]', index))) continue;
        await check(`${target} › ${row}`);
        const subRows = await rowTitles(page);
        // Second level only when the row opened a new menu (not the same list again).
        if (subRows.length && subRows.join("|") !== rows.join("|")) {
          for (const [subIndex, subRow] of subRows.entries()) {
            await open(target);
            await settle(page);
            await clickNth('[data-testid="menu-row"]', index);
            await settle(page);
            if (!(await clickNth('[data-testid="menu-row"]', subIndex))) continue;
            await check(`${target} › ${row} › ${subRow}`);
          }
        }
        for (const [sheetIndex, sheet] of (await sheetTitles(page)).entries()) {
          await open(target);
          await settle(page);
          await clickNth('[data-testid="menu-row"]', index);
          await settle(page);
          await clickNth('[data-testid="sheet-tab"]', sheetIndex);
          await check(`${target} › ${row} › ${sheet}`);
        }
      }
    }
    report[role] = { visited, problems };
    mkdirSync(join("e2e", "results"), { recursive: true });
    writeFileSync(join("e2e", "results", `explore-${role}.json`), JSON.stringify({ visited, problems }, null, 2));
    // Any crash, script error or refused server call fails the run (details in e2e/results).
    expect(problems.map((problem) => `${problem.where} — ${problem.kind} — ${problem.detail}`)).toEqual([]);
  });
}

test.afterAll(() => {
  mkdirSync(join("e2e", "report"), { recursive: true });
  writeFileSync(join("e2e", "report", "explore.json"), JSON.stringify(report, null, 2));
});
