import { createContext, useContext } from "react";
import { supabase } from "../lib/supabase";
import type { Role } from "./account";

export type Feature =
  | "home.view" | "alerts.view" | "orders.view"
  | "orders.decide" | "orders.plan" | "orders.ship" | "orders.create" | "production.view" | "production.update"
  | "clients.view" | "clients.edit" | "clients.create" | "invoices.manage" | "products.manage"
  | "messages.manage" | "team.messages" | "claims.manage" | "deliveries" | "fleet.manage" | "audit.view"
  | "client.home" | "client.order" | "client.orders" | "client.alerts"
  | "client.invoices" | "client.messages" | "client.claims";

export type Audience = "team" | "customer";
export type SettingsBlock = { key: string; title: string; icon: string; audience: Audience; items: { key: Feature; label: string }[] };

// Settings are grouped by theme; each block is set per role, then per user (or per client record).
export const featureBlocks: SettingsBlock[] = [
  { key: "home", title: "Accueil et alertes", icon: "home-outline", audience: "team", items: [
    { key: "home.view", label: "Onglet Accueil (tableau de bord)" },
    { key: "alerts.view", label: "Onglet Alertes" },
  ] },
  { key: "orders", title: "Commandes", icon: "receipt-outline", audience: "team", items: [
    { key: "orders.view", label: "Onglet Commandes" },
    { key: "orders.create", label: "Passer une commande pour un client" },
    { key: "orders.decide", label: "Accepter, décliner, mettre en attente" },
    { key: "orders.plan", label: "Planifier la file de production (onglet Planning)" },
    { key: "claims.manage", label: "Traiter les réclamations" },
  ] },
  { key: "production", title: "Production", icon: "construct-outline", audience: "team", items: [
    { key: "production.view", label: "Onglet Production" },
    { key: "production.update", label: "Commencer / terminer les préparations" },
  ] },
  { key: "delivery", title: "Livraisons et flotte", icon: "car-outline", audience: "team", items: [
    { key: "deliveries", label: "Onglet Livraisons (remise au client)" },
    { key: "orders.ship", label: "Expédier les commandes préparées" },
    { key: "fleet.manage", label: "Gérer la flotte de véhicules" },
  ] },
  { key: "clients", title: "Clients et catalogue", icon: "people-outline", audience: "team", items: [
    { key: "clients.view", label: "Onglet Clients" },
    { key: "clients.edit", label: "Modifier les fiches et points de livraison" },
    { key: "clients.create", label: "Créer des clients" },
    { key: "products.manage", label: "Gérer les produits" },
  ] },
  { key: "billing", title: "Messages et factures", icon: "chatbubbles-outline", audience: "team", items: [
    { key: "team.messages", label: "Messagerie entre membres de l’équipe" },
    { key: "messages.manage", label: "Messagerie avec les clients" },
    { key: "invoices.manage", label: "Onglet Factures" },
  ] },
  { key: "audit", title: "Traçabilité", icon: "time-outline", audience: "team", items: [
    { key: "audit.view", label: "Consulter le journal des actions" },
  ] },
  { key: "client", title: "Espace client", icon: "storefront-outline", audience: "customer", items: [
    { key: "client.home", label: "Onglet Accueil" },
    { key: "client.order", label: "Onglet Commander" },
    { key: "client.orders", label: "Onglet Mes commandes" },
    { key: "client.alerts", label: "Onglet Alertes" },
    { key: "client.invoices", label: "Onglet Mes factures" },
    { key: "client.messages", label: "Messages" },
    { key: "client.claims", label: "Réclamations" },
  ] },
];

export const configurableRoles: { role: Role; label: string; short: string; audience: Audience }[] = [
  { role: "supervisor", label: "Superviseur", short: "Superv.", audience: "team" },
  { role: "production", label: "Production", short: "Prod.", audience: "team" },
  { role: "driver", label: "Livreur", short: "Livreur", audience: "team" },
  { role: "customer", label: "Client", short: "Client", audience: "customer" },
];

// Client options: one value for all clients, which a client record may override.
export type ClientOptionKey = "show_prices" | "show_origin" | "show_stock" | "stock_managed" | "invoice_mode" | "reception_qr"
  | "history_enabled" | "reconfirm_declined" | "scan_delivery_note" | "scan_client_qr";
export const clientOptionBlocks: { title: string; items: { key: ClientOptionKey; label: string; hint: string }[] }[] = [
  { title: "Affichage", items: [
    { key: "show_prices", label: "Afficher les prix", hint: "Dans l’application et sur les bons de livraison." },
    { key: "show_origin", label: "Afficher l’origine des produits", hint: "Producteur, région et label." },
    { key: "show_stock", label: "Afficher le stock disponible", hint: "Quantité disponible au moment de commander." },
  ] },
  { title: "Commandes", items: [
    { key: "stock_managed", label: "Commandes limitées au stock", hint: "Sinon : production à la demande, sans limite." },
    { key: "history_enabled", label: "Historique visible par le client", hint: "Commandes livrées ou annulées et suivi détaillé." },
    { key: "reconfirm_declined", label: "Reconfirmation par le client", hint: "Désactivée : une commande rouverte repasse directement en acceptée." },
  ] },
  { title: "Livraison", items: [
    { key: "scan_delivery_note", label: "Scan du bon de livraison", hint: "Le livreur scanne le QR de chaque bon à la remise." },
    { key: "scan_client_qr", label: "Scan du QR client", hint: "QR collé au point de livraison (ou QR de réception)." },
    { key: "reception_qr", label: "QR de réception dans l’appli du client", hint: "Remplace le QR collé au point de livraison." },
  ] },
  { title: "Facturation", items: [
    { key: "invoice_mode", label: "Facture automatique à l’acceptation", hint: "Sinon : factures regroupées par l’équipe." },
  ] },
];
export const clientOptionKeys = clientOptionBlocks.flatMap((block) => block.items.map((item) => item.key));

// invoice_mode is stored as "auto" | "manual"; the screens show it as a yes/no option.
export const optionToBool = (key: ClientOptionKey, value: unknown) => key === "invoice_mode" ? value === "auto" : value === true;
export const boolToOption = (key: ClientOptionKey, value: boolean): boolean | string => key === "invoice_mode" ? (value ? "auto" : "manual") : value;

export const PermissionsContext = createContext<ReadonlySet<string>>(new Set());

// True when the signed-in account may use the feature (admins have every feature).
export function useCan() {
  const features = useContext(PermissionsContext);
  return (feature: Feature) => features.has(feature);
}

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchRolePermissions(): Promise<{ role: Role; feature: Feature; allowed: boolean }[]> {
  const { data, error } = await client().from("role_permissions").select("role, feature, allowed");
  if (error) throw error;
  return (data ?? []) as { role: Role; feature: Feature; allowed: boolean }[];
}

export async function setRolePermission(role: Role, feature: Feature, allowed: boolean): Promise<void> {
  const { error } = await client().rpc("admin_set_permission", { p_role: role, p_feature: feature, p_allowed: allowed });
  if (error) throw error;
}

export async function fetchUserPermissions(): Promise<{ user_id: string; feature: Feature; allowed: boolean }[]> {
  const { data, error } = await client().from("user_permissions").select("user_id, feature, allowed");
  if (error) throw error;
  return (data ?? []) as { user_id: string; feature: Feature; allowed: boolean }[];
}

// null removes the exception: the user follows its role again.
export async function setUserPermission(userId: string, feature: Feature, allowed: boolean | null): Promise<void> {
  const { error } = await client().rpc("admin_set_user_permission", { p_user_id: userId, p_feature: feature, p_allowed: allowed });
  if (error) throw error;
}

export async function fetchClientDefaults(): Promise<Partial<Record<ClientOptionKey, unknown>>> {
  const { data, error } = await client().from("client_setting_defaults").select("key, value");
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((row: { key: string; value: unknown }) => [row.key, row.value]));
}

export async function setClientDefault(key: ClientOptionKey, value: boolean | string): Promise<void> {
  const { error } = await client().rpc("admin_set_client_default", { p_key: key, p_value: value });
  if (error) throw error;
}
