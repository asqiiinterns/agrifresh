import { supabase } from "../lib/supabase";
import { fetchAccounts } from "./admin";
import { fetchClaims, type Claim } from "./claims";
import { fetchBillingBoard, type BillingBoard } from "./invoices";
import type { Feature } from "./permissions";
import { fetchReturns, type ProductReturn } from "./returns";
import { fetchAllOrders, type StaffOrder } from "./staff";
import { fetchIncidents, fetchLeaves, type Incident, type Leave } from "./workplace";

export type WaitingMessages = {
  clients: { client_id: string; business_name: string; count: number; since: string; last_body: string }[];
  team: { conversation_id: string; title: string; count: number; since: string; last_body: string }[];
};

// Everything on hold, for « À décider »: each list only if the profile may act on it.
export type DecisionBoard = {
  toDecide: StaffOrder[];
  special: StaffOrder[];
  reschedule: StaffOrder[];
  claims: Claim[];
  messages: WaitingMessages;
  billing: BillingBoard;
  returns: ProductReturn[];
  accounts: number;
  leaves: Leave[];
  incidents: Incident[];
};

export const decisionCount = (board: DecisionBoard) => board.toDecide.length + board.special.length + board.reschedule.length + board.claims.length
  + board.messages.clients.length + board.messages.team.length + board.billing.due.length + board.billing.overdue.length + board.returns.length + board.accounts + board.leaves.length + board.incidents.length;

async function fetchWaitingMessages(): Promise<WaitingMessages> {
  if (!supabase) return { clients: [], team: [] };
  const { data, error } = await supabase.rpc("messages_needing_reply");
  if (error || !data || Array.isArray(data)) return { clients: [], team: [] };
  return data as WaitingMessages;
}

export async function fetchDecisionBoard(can: (feature: Feature) => boolean, isAdmin: boolean): Promise<DecisionBoard> {
  const ordersAllowed = can("orders.view") || can("orders.decide") || can("orders.plan");
  const today = new Date().toISOString().slice(0, 10);
  // One wave: every list is requested at the same time.
  const [orders, claims, messages, billing, returns, accounts, leaves, incidents] = await Promise.all([
    ordersAllowed ? fetchAllOrders().catch(() => [] as StaffOrder[]) : Promise.resolve([] as StaffOrder[]),
    can("claims.manage") ? fetchClaims().catch(() => [] as Claim[]) : Promise.resolve([] as Claim[]),
    can("messages.manage") || can("team.messages") ? fetchWaitingMessages() : Promise.resolve({ clients: [], team: [] }),
    can("invoices.manage") ? fetchBillingBoard().catch(() => ({ due: [], overdue: [] })) : Promise.resolve({ due: [], overdue: [] }),
    can("returns.manage") ? fetchReturns().catch(() => [] as ProductReturn[]) : Promise.resolve([] as ProductReturn[]),
    isAdmin ? fetchAccounts().catch(() => []) : Promise.resolve([]),
    can("leave.manage") || isAdmin ? fetchLeaves(today, "2100-01-01").catch(() => [] as Leave[]) : Promise.resolve([] as Leave[]),
    can("incidents.manage") ? fetchIncidents().catch(() => [] as Incident[]) : Promise.resolve([] as Incident[]),
  ]);
  return {
    toDecide: can("orders.decide") ? orders.filter((order) => ["pending", "on_hold", "awaiting_client"].includes(order.status)) : [],
    special: orders.filter((order) => order.special_follow),
    reschedule: can("orders.plan") ? orders.filter((order) => order.needs_reschedule && ["confirmed", "preparing", "ready"].includes(order.status)) : [],
    claims: claims.filter((claim) => claim.status === "open" || claim.status === "in_progress"),
    messages,
    billing,
    returns: returns.filter((item) => ["requested", "approved", "received"].includes(item.status)),
    accounts: accounts.filter((account) => account.status === "pending").length,
    leaves: leaves.filter((leave) => leave.status === "pending" && !leave.mine),
    incidents: incidents.filter((incident) => incident.status === "open"),
  };
}
