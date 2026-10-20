import { supabase } from "../lib/supabase";

export type AuditEntry = {
  id: number;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  entity: string;
  entity_id: string | null;
  label: string | null;
  action: "insert" | "update" | "delete";
  changes: Record<string, unknown> | null;
};

export const entityLabels: Record<string, string> = {
  orders: "Commandes",
  clients: "Clients",
  client_delivery_points: "Points de livraison",
  products: "Produits",
  role_permissions: "Droits par rôle",
  user_permissions: "Droits par utilisateur",
  client_setting_defaults: "Options clients",
  profiles: "Comptes",
  client_invoices: "Factures",
  claims: "Réclamations",
  vehicles: "Flotte",
  shipments: "Expéditions",
  messages: "Messages",
  notification_settings: "Alertes",
  app_settings: "Réglages e-mail",
  home_layouts: "Accueil",
  returns: "Retours",
  credit_notes: "Avoirs",
  document_numbering: "Numérotation",
};

const fieldLabels: Record<string, string> = {
  status: "statut", status_note: "motif", production_rank: "rang de production", requested_delivery_date: "date de livraison",
  total: "total", allowed: "autorisé", role: "rôle", account_status: "statut du compte", active: "actif", price: "prix",
  stock_quantity: "stock", business_name: "nom", show_prices: "prix affichés", show_origin: "origine affichée",
  show_stock: "stock affiché", stock_managed: "stock géré", invoice_mode: "facturation", reception_qr: "QR de réception",
  history_enabled: "historique client", reconfirm_declined: "reconfirmation", scan_delivery_note: "scan du bon",
  scan_client_qr: "scan du QR client", custom_settings: "options spécifiques", feature_overrides: "onglets client",
  value: "valeur", label: "libellé", plate: "immatriculation", shipment_id: "expédition", delivered_at: "livrée le",
  delivered_by: "livrée par", staff_response: "réponse", invoice_number: "numéro", paid_at: "payée le",
};

export const actionLabels = { insert: "Création", update: "Modification", delete: "Suppression" } as const;

const short = (value: unknown) => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "oui" : "non";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

// "statut : pending → confirmed" lines for an update, key fields for a creation.
export function describeChanges(entry: AuditEntry): string[] {
  if (!entry.changes) return [];
  const pairs = Object.entries(entry.changes).filter(([key]) => !["id", "created_at", "client_id", "customer_id", "delivery_point_id", "address_snapshot"].includes(key));
  if (entry.action === "update") {
    return pairs.map(([key, value]) => {
      const [before, after] = Array.isArray(value) ? value : [null, value];
      return `${fieldLabels[key] ?? key} : ${short(before)} → ${short(after)}`;
    });
  }
  return pairs.slice(0, 6).map(([key, value]) => `${fieldLabels[key] ?? key} : ${short(value)}`);
}

export async function fetchAudit(since: string, until?: string): Promise<AuditEntry[]> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  let query = supabase.from("audit_log").select("*").gte("at", since).order("at", { ascending: false }).limit(1000);
  if (until) query = query.lt("at", until);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AuditEntry[];
}
