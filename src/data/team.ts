import { supabase } from "../lib/supabase";
import type { Role } from "./account";

export type TeamMember = { id: string; email: string; full_name: string; role: Role };

export const assignableRoles: { role: Role; label: string; description: string }[] = [
  { role: "admin", label: "Administrateur", description: "Tout, dont les clients, l’équipe et les factures." },
  { role: "supervisor", label: "Superviseur", description: "Commandes, planification, factures, réclamations, messages." },
  { role: "production", label: "Production", description: "Onglet Production : quantités à préparer, file, historique." },
  { role: "driver", label: "Livreur", description: "Livraisons et scans." },
  { role: "customer", label: "Retirer de l’équipe", description: "Le compte n’a plus d’accès interne." },
];

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchTeam(): Promise<TeamMember[]> {
  const { data, error } = await client().rpc("admin_list_team");
  if (error) throw error;
  return (data ?? []) as TeamMember[];
}

// The person must have activated an account in the app first.
export async function setMemberRole(email: string, role: Role): Promise<void> {
  const { error } = await client().rpc("admin_set_role", { p_email: email.trim().toLowerCase(), p_role: role });
  if (error) throw error;
}
