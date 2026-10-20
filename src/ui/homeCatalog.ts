import type { HomeLayout } from "../data/account";
import type { Audience, Feature } from "../data/permissions";
import type { IconName, NavParams, TabKey } from "./navigation";

// "admin" = administrators only; otherwise the feature the item needs.
type Need = Feature | "admin" | null;

export type HomeTileDef = { key: string; label: string; icon: IconName; audience: Audience; need: Need; tab: TabKey; params?: NavParams; tone?: "action" | "warn" };
export type HomeShortcutDef = { key: string; label: string; icon: IconName; audience: Audience; need: Need; tab: TabKey; params?: NavParams };

export const homeTiles: HomeTileDef[] = [
  { key: "decide", label: "À décider", icon: "hourglass-outline", audience: "team", need: "orders.decide", tab: "orders", params: { section: "decide" }, tone: "action" },
  { key: "placedToday", label: "Commandes du jour", icon: "today-outline", audience: "team", need: "orders.view", tab: "orders", params: { section: "queue" } },
  { key: "queue", label: "En file de production", icon: "list-outline", audience: "team", need: "orders.plan", tab: "planning" },
  { key: "prepare", label: "À préparer", icon: "construct-outline", audience: "team", need: "production.view", tab: "production", params: { section: "prepare" } },
  { key: "ready", label: "Prêtes à expédier", icon: "cube-outline", audience: "team", need: "orders.ship", tab: "deliveries" },
  { key: "shipping", label: "En livraison", icon: "car-outline", audience: "team", need: "deliveries", tab: "deliveries" },
  { key: "dueToday", label: "À livrer aujourd’hui", icon: "calendar-outline", audience: "team", need: "orders.view", tab: "orders", params: { section: "queue" }, tone: "warn" },
  { key: "claims", label: "Réclamations", icon: "alert-circle-outline", audience: "team", need: "claims.manage", tab: "orders", params: { section: "claims" }, tone: "warn" },
  { key: "accounts", label: "Comptes à valider", icon: "person-add-outline", audience: "team", need: "admin", tab: "admin", params: { page: "accounts" }, tone: "warn" },
  { key: "messages", label: "Messages non lus", icon: "chatbubbles-outline", audience: "team", need: "messages.manage", tab: "messages", tone: "action" },
  { key: "alerts", label: "Alertes non lues", icon: "notifications-outline", audience: "team", need: "alerts.view", tab: "alerts", tone: "action" },
  { key: "c_progress", label: "Commandes en cours", icon: "receipt-outline", audience: "customer", need: "client.orders", tab: "orders" },
  { key: "c_reconfirm", label: "À reconfirmer", icon: "help-circle-outline", audience: "customer", need: "client.orders", tab: "orders", tone: "warn" },
  { key: "c_shipped", label: "En route", icon: "car-outline", audience: "customer", need: "client.orders", tab: "orders" },
  { key: "c_invoices", label: "Factures à régler", icon: "document-text-outline", audience: "customer", need: "client.invoices", tab: "invoices", tone: "warn" },
  { key: "c_messages", label: "Messages non lus", icon: "chatbubbles-outline", audience: "customer", need: "client.messages", tab: "messages", tone: "action" },
  { key: "c_alerts", label: "Alertes non lues", icon: "notifications-outline", audience: "customer", need: "client.alerts", tab: "alerts", tone: "action" },
];

export const homeShortcuts: HomeShortcutDef[] = [
  { key: "staffOrder", label: "Commander pour un client", icon: "add-circle-outline", audience: "team", need: "orders.create", tab: "staffOrder" },
  { key: "planning", label: "Planifier la production", icon: "list-outline", audience: "team", need: "orders.plan", tab: "planning" },
  { key: "decide", label: "Commandes à décider", icon: "hourglass-outline", audience: "team", need: "orders.decide", tab: "orders", params: { section: "decide" } },
  { key: "closed", label: "Commandes clôturées", icon: "archive-outline", audience: "team", need: "orders.view", tab: "orders", params: { section: "done" } },
  { key: "production", label: "Quantités à préparer", icon: "construct-outline", audience: "team", need: "production.view", tab: "production", params: { section: "prepare" } },
  { key: "deliveries", label: "Livraisons", icon: "car-outline", audience: "team", need: "deliveries", tab: "deliveries" },
  { key: "clients", label: "Fiches clients", icon: "people-outline", audience: "team", need: "clients.view", tab: "clients" },
  { key: "invoices", label: "Factures", icon: "document-text-outline", audience: "team", need: "invoices.manage", tab: "invoices" },
  { key: "messages", label: "Messages", icon: "chatbubbles-outline", audience: "team", need: "messages.manage", tab: "messages" },
  { key: "accounts", label: "Comptes", icon: "person-outline", audience: "team", need: "admin", tab: "admin", params: { page: "accounts" } },
  { key: "settings", label: "Paramétrage", icon: "options-outline", audience: "team", need: "admin", tab: "admin", params: { page: "settings" } },
  { key: "fleet", label: "Flotte de livraison", icon: "bus-outline", audience: "team", need: "fleet.manage", tab: "admin", params: { page: "fleet" } },
  { key: "audit", label: "Journal des actions", icon: "time-outline", audience: "team", need: "audit.view", tab: "admin", params: { page: "audit" } },
  { key: "c_order", label: "Passer une commande", icon: "add-circle-outline", audience: "customer", need: "client.order", tab: "order" },
  { key: "c_orders", label: "Mes commandes", icon: "receipt-outline", audience: "customer", need: "client.orders", tab: "orders" },
  { key: "c_invoices", label: "Mes factures", icon: "document-text-outline", audience: "customer", need: "client.invoices", tab: "invoices" },
  { key: "c_messages", label: "Écrire à AgriFresh", icon: "chatbubbles-outline", audience: "customer", need: "client.messages", tab: "messages" },
  { key: "c_account", label: "Mon compte", icon: "person-circle-outline", audience: "customer", need: null, tab: "account" },
];

// Built-in layout when neither the user nor the admin chose one.
export const defaultLayout = (audience: Audience): HomeLayout => audience === "team"
  ? { tiles: ["decide", "placedToday", "queue", "prepare", "ready", "shipping", "claims", "accounts", "messages"], shortcuts: ["staffOrder", "planning", "decide", "production", "clients"] }
  : { tiles: ["c_progress", "c_reconfirm", "c_shipped", "c_invoices", "c_messages"], shortcuts: ["c_order", "c_orders", "c_invoices", "c_messages"] };

export function allowedFor(need: Need, can: (feature: Feature) => boolean, isAdmin: boolean) {
  if (need === null) return true;
  if (need === "admin") return isAdmin;
  return isAdmin || can(need);
}
