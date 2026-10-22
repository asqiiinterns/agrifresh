// Screenshots for the user manual (local test database with example data):
//   node e2e/setup.mjs && node e2e/demo-data.mjs && npx playwright test -c e2e/manual
// Each shot: an account, then steps — tid:<testID> · row:<menu entry> · sheet:<sheet> · text:<visible words> · back.
import { test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settle, signIn } from "../tests/helpers";

type Shot = { name: string; account: string; steps: string[] };
const shots: Shot[] = [
  // Premiers pas
  { name: "01-connexion", account: "", steps: [] },
  { name: "02-accueil-fournisseur", account: "owner", steps: ["tid:bar-home"] },
  { name: "03-plus-fournisseur", account: "owner", steps: ["tid:bar-account"] },
  { name: "04-accueil-acheteur", account: "buyer", steps: ["tid:bar-home"] },
  // Acheteur
  { name: "10-commander", account: "buyer", steps: ["tid:bar-order"] },
  { name: "11-mes-commandes", account: "buyer", steps: ["tid:bar-orders"] },
  { name: "12-commandes-cloturees", account: "buyer", steps: ["tid:bar-orders", "sheet:Clôturées"] },
  { name: "13-factures-acheteur", account: "buyer", steps: ["tid:bar-invoices"] },
  { name: "14-compte-acheteur", account: "buyer", steps: ["tid:bar-invoices", "sheet:Mon compte"] },
  { name: "15-recurrentes", account: "buyer", steps: ["tid:bar-recurring"] },
  { name: "16-decouvrir", account: "buyer", steps: ["tid:bar-account", "row:Découvrir"] },
  // Fournisseur — commandes
  { name: "20-a-decider", account: "owner", steps: ["tid:bar-decide"] },
  { name: "21-commandes-en-cours", account: "owner", steps: ["tid:bar-production", "sheet:En cours"] },
  { name: "22-commandes-a-decider", account: "owner", steps: ["tid:bar-production", "sheet:À décider"] },
  { name: "23-commandes-cloturees", account: "owner", steps: ["tid:bar-production", "sheet:Clôturées"] },
  { name: "24-commander-pour-client", account: "owner", steps: ["tid:bar-account", "row:Commander"] },
  // Planning et production
  { name: "30-planning", account: "owner", steps: ["tid:bar-production", "sheet:Planning"] },
  { name: "31-production", account: "owner", steps: ["tid:bar-production", "sheet:Production"] },
  { name: "32-production-preparateur", account: "production", steps: ["tid:bar-production"] },
  // Livraisons
  { name: "40-a-recuperer", account: "driver", steps: ["tid:bar-deliveries", "sheet:À récupérer"] },
  { name: "41-a-livrer", account: "driver", steps: ["tid:bar-deliveries", "sheet:À livrer"] },
  { name: "42-historique-livraisons", account: "driver", steps: ["tid:bar-deliveries", "sheet:Historique"] },
  // Facturation
  { name: "50-factures", account: "owner", steps: ["tid:bar-invoices", "sheet:Factures"] },
  { name: "51-comptes-clients", account: "owner", steps: ["tid:bar-invoices", "sheet:Comptes clients"] },
  { name: "52-tableau-de-bord", account: "owner", steps: ["tid:bar-invoices", "sheet:Tableau de bord"] },
  { name: "53-avoirs", account: "owner", steps: ["tid:bar-invoices", "sheet:Avoirs"] },
  { name: "54-retours", account: "owner", steps: ["tid:bar-account", "row:Retours et avoirs"] },
  // Catalogue
  { name: "60-produits", account: "owner", steps: ["tid:bar-account", "row:Produits"] },
  { name: "61-remises", account: "owner", steps: ["tid:bar-account", "row:Remises et tarifs"] },
  // Clients et réseau
  { name: "70-clients", account: "owner", steps: ["tid:bar-account", "row:Clients"] },
  { name: "71-reseau", account: "owner", steps: ["tid:bar-account", "row:Réseau"] },
  { name: "72-invitations", account: "owner", steps: ["tid:bar-account", "row:Comptes", "back", "tid:bar-account", "row:Invitations"] },
  // Messages et notifications
  { name: "80-messages", account: "owner", steps: ["tid:top-messages"] },
  { name: "81-messages-equipe", account: "owner", steps: ["tid:top-messages", "sheet:Équipe"] },
  { name: "82-notifications", account: "owner", steps: ["tid:top-alerts"] },
  { name: "83-messages-acheteur", account: "buyer", steps: ["tid:top-messages"] },
  // Vie d'équipe
  { name: "90-calendrier", account: "owner", steps: ["tid:bar-account", "row:Calendrier"] },
  { name: "91-conges", account: "driver", steps: ["tid:bar-leaves", "sheet:Nouvelle demande"] },
  { name: "92-incidents", account: "driver", steps: ["tid:bar-incidents", "sheet:Signaler"] },
  { name: "93-statistiques", account: "owner", steps: ["tid:bar-account", "row:Statistiques"] },
  { name: "94-localisation", account: "owner", steps: ["tid:bar-account", "row:Localisation"] },
  // Administration du Pro
  { name: "A0-comptes", account: "owner", steps: ["tid:bar-account", "row:Comptes"] },
  { name: "A1-roles", account: "owner", steps: ["tid:bar-account", "row:Rôles et accès"] },
  { name: "A2-parametrage", account: "owner", steps: ["tid:bar-account", "row:Paramétrage"] },
  { name: "A3-notifications-emails", account: "owner", steps: ["tid:bar-account", "row:Notifications et e-mails"] },
  { name: "A4-flotte", account: "owner", steps: ["tid:bar-account", "row:Flotte"] },
  { name: "A5-journal", account: "owner", steps: ["tid:bar-account", "row:Journal des actions"] },
  { name: "A6-mon-profil", account: "owner", steps: ["tid:bar-account", "row:Mon profil et mot de passe"] },
  { name: "A7-affichage", account: "owner", steps: ["tid:bar-account", "row:Affichage et langue"] },
  // Appro+
  { name: "B0-pros", account: "platform", steps: ["tid:bar-pros"] },
  { name: "B1-plateforme-parametrage", account: "platform", steps: ["text:Paramétrage"] },
];

const dir = join("e2e", "shots");
mkdirSync(dir, { recursive: true });
const done: Record<string, string> = {};

test.describe.configure({ mode: "serial" });
for (const shot of shots) {
  test(shot.name, async ({ page }) => {
    if (shot.account) await signIn(page, shot.account);
    else await page.goto("/");
    await settle(page);
    for (const step of shot.steps) {
      const [kind, ...rest] = step.split(":");
      const value = rest.join(":");
      try {
        if (kind === "tid") await page.getByTestId(value).first().click({ timeout: 8_000 });
        else if (kind === "row") await page.getByTestId("menu-row").filter({ has: page.getByText(value, { exact: true }) }).first().click({ timeout: 8_000 });
        else if (kind === "sheet") await page.getByTestId("sheet-tab").filter({ hasText: value }).first().click({ timeout: 8_000 });
        else if (kind === "text") await page.getByText(value, { exact: true }).first().click({ timeout: 8_000 });
        else if (kind === "back") await page.goBack();
      } catch {
        done[shot.name] = `étape introuvable : ${step}`;
      }
      await settle(page);
    }
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(dir, `${shot.name}.png`) });
    done[shot.name] ??= "ok";
    writeFileSync(join(dir, "index.json"), JSON.stringify(done, null, 2));
  });
}
