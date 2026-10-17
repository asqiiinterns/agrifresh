import { supabase } from "../lib/supabase";

export type ClaimReason = "missing" | "quantity" | "quality" | "late" | "other";
export type ClaimStatus = "open" | "in_progress" | "resolved" | "rejected";

export type Claim = {
  id: string;
  claim_number: number;
  order_id: string;
  client_id: string;
  reason: ClaimReason;
  description: string;
  status: ClaimStatus;
  staff_response: string | null;
  created_at: string;
  resolved_at: string | null;
  orders?: { order_number: number } | null;
  clients?: { business_name: string } | null;
};

export const claimReasons: { key: ClaimReason; label: string }[] = [
  { key: "missing", label: "Produit manquant" },
  { key: "quantity", label: "Quantité incorrecte" },
  { key: "quality", label: "Qualité" },
  { key: "late", label: "Retard de livraison" },
  { key: "other", label: "Autre" },
];

export const claimReasonLabel = (reason: ClaimReason) => claimReasons.find((item) => item.key === reason)?.label ?? reason;

export const claimStatusStyle: Record<ClaimStatus, { label: string; color: string; background: string }> = {
  open: { label: "Ouverte", color: "#7a5a12", background: "#fbf0d5" },
  in_progress: { label: "En traitement", color: "#2f5d8a", background: "#e3edf7" },
  resolved: { label: "Résolue", color: "#24543b", background: "#dcebd7" },
  rejected: { label: "Rejetée", color: "#a63d2f", background: "#f8e5e1" },
};

const FIELDS = "id, claim_number, order_id, client_id, reason, description, status, staff_response, created_at, resolved_at, orders(order_number), clients(business_name)";

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

// RLS: clients get their own claims, staff get all of them.
export async function fetchClaims(): Promise<Claim[]> {
  const { data, error } = await client().from("claims").select(FIELDS).order("created_at", { ascending: false }).limit(300);
  if (error) throw error;
  return (data ?? []) as unknown as Claim[];
}

export async function createClaim(orderId: string, reason: ClaimReason, description: string): Promise<void> {
  const { error } = await client().rpc("client_create_claim", { p_order_id: orderId, p_reason: reason, p_description: description.trim() });
  if (error) throw error;
}

export async function updateClaim(claimId: string, status: ClaimStatus, response?: string): Promise<void> {
  const { error } = await client().rpc("staff_update_claim", { p_claim_id: claimId, p_status: status, p_response: response?.trim() || null });
  if (error) throw error;
}
