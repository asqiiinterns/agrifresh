import { createContext, useContext, useMemo } from "react";
import { supabase } from "../lib/supabase";
import { clientOptionBlocks, featureBlocks, type ClientOptionKey, type Feature } from "./permissions";
import type { IconName } from "../ui/navigation";

// Modules: a module that is off disappears (menus, buttons, settings), admins included.
// Appro+ sets the default of each module and the plan of each Pro (included / excluded); within its plan,
// the Pro's Responsable switches each module on or off (20261118_pro_modules_pricing.sql).
// Same keys as supabase/migrations/20261107_modules.sql, which also enforces them on the server.
export type ModuleKey =
  | "decide" | "production" | "planning" | "delivery" | "delivery_qr" | "signature" | "fleet" | "invoicing" | "reminders"
  | "exports" | "returns" | "claims" | "client_messages" | "team_messages" | "attachments" | "needs_reply" | "staff_orders"
  | "recurring" | "order_tags" | "stock" | "origin" | "reconfirm" | "calendar" | "leaves" | "incidents" | "location" | "stats"
  | "audit" | "languages" | "home_custom" | "pricing";

export type ModuleDef = { key: ModuleKey; label: string; description: string; icon: IconName; requires?: ModuleKey[] };

export const moduleGroups: { title: string; modules: ModuleDef[] }[] = [
  { title: "Ventes et commandes", modules: [
    { key: "decide", label: "À décider", description: "Onglet qui regroupe tout ce qui attend une décision.", icon: "checkmark-done-outline" },
    { key: "staff_orders", label: "Commande saisie par l’équipe", description: "L’équipe passe une commande pour un client.", icon: "create-outline" },
    { key: "pricing", label: "Remises et tarifs clients", description: "Remises, prix négociés, groupes de clients, calculés en direct dans le panier.", icon: "pricetag-outline" },
    { key: "recurring", label: "Commandes récurrentes", description: "Une commande se répète automatiquement (jours, fréquence).", icon: "repeat-outline" },
    { key: "order_tags", label: "Étiquettes de commande", description: "★ Suivi spécial et ↻ À reprogrammer.", icon: "pricetags-outline" },
    { key: "reconfirm", label: "Reconfirmation par le client", description: "Une commande rouverte attend l’accord du client.", icon: "help-circle-outline" },
    { key: "stock", label: "Gestion du stock", description: "Stock affiché et commandes limitées au stock.", icon: "cube-outline" },
    { key: "origin", label: "Origine des produits", description: "Producteur, région et label affichés.", icon: "leaf-outline" },
  ] },
  { title: "Préparation et livraison", modules: [
    { key: "production", label: "Production", description: "Préparation des commandes, client par client.", icon: "construct-outline" },
    { key: "planning", label: "Planning", description: "Ordre de la file de production.", icon: "calendar-number-outline" },
    { key: "delivery", label: "Livraisons", description: "Expédition, remise au client, mode hors ligne du livreur.", icon: "car-outline" },
    { key: "delivery_qr", label: "Contrôle par QR", description: "Scan du bon de livraison et du QR client à la remise.", icon: "qr-code-outline", requires: ["delivery"] },
    { key: "signature", label: "Signature à la livraison", description: "Le client signe sur l’écran du livreur.", icon: "brush-outline", requires: ["delivery"] },
    { key: "fleet", label: "Flotte de véhicules", description: "Véhicules et affectation des tournées.", icon: "bus-outline", requires: ["delivery"] },
  ] },
  { title: "Facturation", modules: [
    { key: "invoicing", label: "Facturation", description: "Factures, paiements partiels, tableau de bord.", icon: "document-text-outline" },
    { key: "reminders", label: "Relances de paiement", description: "Rappels automatiques après l’échéance.", icon: "alarm-outline", requires: ["invoicing"] },
    { key: "exports", label: "Exports Excel et comptables", description: "Export des factures et avoirs d’une période.", icon: "download-outline", requires: ["invoicing"] },
    { key: "returns", label: "Retours et avoirs", description: "Demandes de retour, avoirs.", icon: "return-down-back-outline" },
    { key: "claims", label: "Réclamations", description: "Le client signale un problème sur une commande.", icon: "alert-circle-outline" },
  ] },
  { title: "Communication", modules: [
    { key: "client_messages", label: "Messages avec les clients", description: "Une conversation par client.", icon: "chatbubbles-outline" },
    { key: "team_messages", label: "Messages entre collègues", description: "Conversations directes, de groupe ou par profil.", icon: "people-outline" },
    { key: "attachments", label: "Pièces jointes", description: "Photo, vidéo, message vocal et document dans les messages.", icon: "attach-outline" },
    { key: "needs_reply", label: "« Nécessite une réponse »", description: "Marquer un message qui attend une réponse.", icon: "alert-outline" },
  ] },
  { title: "Équipe", modules: [
    { key: "calendar", label: "Calendrier et rappels", description: "Rappels avec alarme, vue des livraisons.", icon: "calendar-outline" },
    { key: "leaves", label: "Congés", description: "Demandes et validation des congés.", icon: "airplane-outline" },
    { key: "incidents", label: "Incidents", description: "Incidents de livraison ou de véhicule.", icon: "warning-outline" },
    { key: "location", label: "Localisation", description: "Position partagée avec l’accord de la personne.", icon: "location-outline" },
  ] },
  { title: "Pilotage", modules: [
    { key: "stats", label: "Statistiques", description: "Produits, clients, créneaux, temps de préparation.", icon: "stats-chart-outline" },
    { key: "audit", label: "Journal des actions", description: "Qui a fait quoi, et quand.", icon: "time-outline" },
  ] },
  { title: "Confort", modules: [
    { key: "languages", label: "Langues", description: "Choix du français, de l’anglais ou de l’arabe.", icon: "language-outline" },
    { key: "home_custom", label: "Accueil personnalisable", description: "Chacun choisit ses chiffres et raccourcis.", icon: "options-outline" },
  ] },
];
export const allModules = moduleGroups.flatMap((group) => group.modules);

// Kept on in "Essentiel": what a new customer needs on day one.
export const essentialModules: ModuleKey[] = ["delivery", "invoicing", "client_messages"];

// Rights and client options carried by a module (the rest is always available).
export const featureModule: Partial<Record<Feature, ModuleKey>> = {
  "production.view": "production", "production.update": "production", "orders.plan": "planning",
  deliveries: "delivery", "orders.ship": "delivery", "fleet.manage": "fleet",
  "invoices.manage": "invoicing", "client.invoices": "invoicing", "returns.manage": "returns", "client.returns": "returns",
  "claims.manage": "claims", "client.claims": "claims", "messages.manage": "client_messages", "client.messages": "client_messages",
  "team.messages": "team_messages", "orders.create": "staff_orders", "client.recurring": "recurring", "calendar.view": "calendar",
  "leave.request": "leaves", "leave.manage": "leaves", "incidents.report": "incidents", "incidents.manage": "incidents",
  "location.share": "location", "location.view": "location", "stats.view": "stats", "audit.view": "audit",
};
export const optionModule: Partial<Record<ClientOptionKey, ModuleKey>> = {
  delivery_signature: "signature", driver_prices: "delivery", auto_deliver: "delivery", payment_reminders: "reminders", reminder_opt_out_allowed: "reminders",
  scan_delivery_note: "delivery_qr", scan_client_qr: "delivery_qr", reception_qr: "delivery_qr",
  show_origin: "origin", show_stock: "stock", stock_managed: "stock", reconfirm_declined: "reconfirm", invoice_mode: "invoicing",
};

export type ModuleState = Partial<Record<ModuleKey, boolean>>;
export const ModulesContext = createContext<ModuleState>({});

// A module is on unless switched off, and only if the modules it relies on are on too.
export const isModuleOn = (state: ModuleState, key: ModuleKey): boolean => {
  if (state[key] === false) return false;
  const def = allModules.find((item) => item.key === key);
  return (def?.requires ?? []).every((parent) => isModuleOn(state, parent));
};

export function useModules() {
  const state = useContext(ModulesContext);
  return (key: ModuleKey) => isModuleOn(state, key);
}

// Paramétrage shows only the rights and options of the modules that are on.
export function useVisibleSettings() {
  const state = useContext(ModulesContext);
  return useMemo(() => {
    const on = (key?: ModuleKey) => !key || isModuleOn(state, key);
    return {
      featureBlocks: featureBlocks.map((block) => ({ ...block, items: block.items.filter((item) => on(featureModule[item.key])) })).filter((block) => block.items.length),
      clientOptionBlocks: clientOptionBlocks.map((block) => ({ ...block, items: block.items.filter((item) => on(optionModule[item.key])) })).filter((block) => block.items.length),
    };
  }, [state]);
}

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

// Before 20261107_modules.sql there is nothing to read: every module counts as on.
export async function fetchModules(): Promise<ModuleState> {
  if (!supabase) return {};
  const { data, error } = await supabase.rpc("app_modules_state");
  if (error || !data) return {};
  return data as ModuleState;
}

// The app listens to reload modules and rights after a change (rights depend on modules).
const listeners = new Set<() => void>();
export function onModulesChanged(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Appro+: the default of a module for every Pro.
export async function setModule(key: ModuleKey, enabled: boolean): Promise<void> {
  const { error } = await client().rpc("admin_set_module", { p_key: key, p_enabled: enabled });
  if (error) throw error;
  listeners.forEach((listener) => listener());
}

export async function fetchModuleDefaults(): Promise<ModuleState> {
  if (!supabase) return {};
  const { data, error } = await supabase.rpc("platform_modules_defaults");
  if (!error && data) return data as ModuleState;
  return fetchModules();
}

// The modules of one Pro (mine when orgId is omitted). Null before 20261118.
export type OrgModule = { default: boolean; granted: boolean | null; included: boolean; enabled: boolean; effective: boolean };
export type OrgModules = Partial<Record<ModuleKey, OrgModule>>;
export async function fetchOrgModules(orgId?: string): Promise<OrgModules | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("org_modules_state", orgId ? { p_org_id: orgId } : {});
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") return null;
    throw error;
  }
  return data as OrgModules;
}

// The Pro's Responsable: on or off within its plan.
export async function setOrgModule(key: ModuleKey, enabled: boolean): Promise<void> {
  const { error } = await client().rpc("org_set_module", { p_key: key, p_enabled: enabled });
  if (error) throw error;
  listeners.forEach((listener) => listener());
}

// Appro+: include (true) or exclude (false) a module in a Pro's plan, or follow the default (null).
export async function setPlanModule(orgId: string, key: ModuleKey, granted: boolean | null): Promise<void> {
  const { error } = await client().rpc("platform_set_org_module", { p_org_id: orgId, p_key: key, p_granted: granted });
  if (error) throw error;
}
