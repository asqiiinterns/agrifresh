import { supabase } from "../lib/supabase";

// Appro+ console: the platform team and the Pros. Never mixed with the Pros' own accounts.
export type PlatformRole = "superadmin" | "support" | "account_manager" | "verification" | "finance" | "viewer";
export const platformRoleLabels: Record<PlatformRole, { label: string; detail: string }> = {
  superadmin: { label: "Super-admin", detail: "Tous les droits de la plateforme, dont l’équipe Appro+." },
  support: { label: "Support", detail: "Consulte les Pros et les aide (accès accordé par le Pro)." },
  account_manager: { label: "Chargé de compte", detail: "Suit ses Pros, leurs rôles et leurs comptes." },
  verification: { label: "Vérification", detail: "Valide les nouveaux Pros et leurs documents." },
  finance: { label: "Finance", detail: "Abonnements et facturation de la plateforme." },
  viewer: { label: "Lecture seule", detail: "Consulte sans rien modifier." },
};

export type PlatformMember = { user_id: string; email: string; full_name: string | null; role: PlatformRole; active: boolean };
export type ProStatus = "pending" | "active" | "suspended" | "refused";
export type ProSummary = {
  id: string; name: string; is_supplier: boolean; is_buyer: boolean; status: ProStatus; email: string; phone: string;
  created_at: string; members: number; clients: number; suppliers: number;
};

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchPlatformTeam(): Promise<PlatformMember[]> {
  const { data, error } = await client().rpc("platform_team");
  if (error) throw error;
  return (data ?? []) as PlatformMember[];
}

// null removes the person from the Appro+ team.
export async function setPlatformMember(email: string, role: PlatformRole | null): Promise<void> {
  const { error } = await client().rpc("platform_set_member", { p_email: email.trim(), p_role: role });
  if (error) throw error;
}

export async function fetchPros(): Promise<ProSummary[]> {
  const { data, error } = await client().rpc("platform_pros");
  if (error) throw error;
  return (data ?? []) as ProSummary[];
}

export async function setProStatus(orgId: string, status: ProStatus): Promise<void> {
  const { error } = await client().rpc("platform_set_pro_status", { p_org_id: orgId, p_status: status });
  if (error) throw error;
}

export async function fetchMyPlatformRole(): Promise<PlatformRole | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("platform_role");
  if (error) return null;
  return (data ?? null) as PlatformRole | null;
}
