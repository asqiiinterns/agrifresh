import { createContext, useContext } from "react";
import { supabase } from "../lib/supabase";
import type { Role } from "./account";

export type Feature =
  | "orders.decide" | "orders.plan" | "orders.ship" | "production.view" | "production.update"
  | "clients.view" | "clients.edit" | "clients.create" | "invoices.manage" | "products.manage"
  | "messages.manage" | "claims.manage" | "deliveries"
  | "client.invoices" | "client.messages" | "client.claims";

// Labels for the admin rights screen, grouped as the team reads them.
export const featureCatalog: { group: string; audience: "team" | "customer"; items: { key: Feature; label: string }[] }[] = [
  { group: "Commandes", audience: "team", items: [
    { key: "orders.decide", label: "Accepter, décliner, mettre en attente" },
    { key: "orders.plan", label: "Planifier la file de production" },
    { key: "orders.ship", label: "Expédier les commandes" },
    { key: "claims.manage", label: "Traiter les réclamations" },
  ] },
  { group: "Production", audience: "team", items: [
    { key: "production.view", label: "Voir l’onglet Production" },
    { key: "production.update", label: "Commencer / terminer les préparations" },
  ] },
  { group: "Clients et catalogue", audience: "team", items: [
    { key: "clients.view", label: "Voir les fiches clients" },
    { key: "clients.edit", label: "Modifier les fiches et points de livraison" },
    { key: "clients.create", label: "Créer des clients" },
    { key: "products.manage", label: "Gérer les produits" },
  ] },
  { group: "Autres", audience: "team", items: [
    { key: "invoices.manage", label: "Factures" },
    { key: "messages.manage", label: "Messagerie avec les clients" },
    { key: "deliveries", label: "Livraisons et scans" },
  ] },
  { group: "Espace client", audience: "customer", items: [
    { key: "client.invoices", label: "Onglet Mes factures" },
    { key: "client.messages", label: "Messages" },
    { key: "client.claims", label: "Réclamations" },
  ] },
];

export const configurableRoles: { role: Role; label: string; audience: "team" | "customer" }[] = [
  { role: "supervisor", label: "Superviseur", audience: "team" },
  { role: "production", label: "Production", audience: "team" },
  { role: "driver", label: "Livreur", audience: "team" },
  { role: "customer", label: "Client", audience: "customer" },
];

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
