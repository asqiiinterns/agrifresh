import { supabase } from "../lib/supabase";
import { ORDER_FIELDS, type Order } from "./orders";

export type OrderStatus = "pending" | "on_hold" | "confirmed" | "declined" | "preparing" | "ready" | "out_for_delivery" | "delivered" | "cancelled";

export type StaffAction = { status: OrderStatus; label: string; variant: "primary" | "secondary" | "danger"; askReason?: boolean };

// Mirrors the transitions enforced by staff_update_order_status in the database.
export const staffActions: Partial<Record<OrderStatus, StaffAction[]>> = {
  pending: [
    { status: "confirmed", label: "ACCEPTER", variant: "primary" },
    { status: "on_hold", label: "METTRE EN ATTENTE", variant: "secondary", askReason: true },
    { status: "declined", label: "DÉCLINER", variant: "danger", askReason: true },
  ],
  on_hold: [
    { status: "confirmed", label: "ACCEPTER", variant: "primary" },
    { status: "declined", label: "DÉCLINER", variant: "danger", askReason: true },
  ],
  confirmed: [{ status: "preparing", label: "COMMENCER LA PRÉPARATION", variant: "primary" }],
  preparing: [{ status: "ready", label: "MARQUER PRÉPARÉE", variant: "primary" }],
  ready: [{ status: "out_for_delivery", label: "EXPÉDIER", variant: "primary" }],
};

export const statusGroups = {
  decide: ["pending", "on_hold"],
  progress: ["confirmed", "preparing", "ready", "out_for_delivery"],
  done: ["delivered", "declined", "cancelled"],
} as const;

export type StaffOrder = Order & {
  clients: { business_name: string; client_number: number } | null;
  delivered_by_profile: { full_name: string } | null;
};

export async function fetchAllOrders(): Promise<StaffOrder[]> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { data, error } = await supabase
    .from("orders")
    .select(`${ORDER_FIELDS}, clients(business_name, client_number), delivered_by_profile:profiles!orders_delivered_by_fkey(full_name)`)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data ?? []) as unknown as StaffOrder[];
}

export async function updateOrderStatus(orderId: string, status: OrderStatus, note?: string): Promise<void> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { error } = await supabase.rpc("staff_update_order_status", {
    p_order_id: orderId,
    p_status: status,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
}

export type PreparationLine = { key: string; name: string; unit: string; quantity: number; orders: number };

// Totals per product across accepted orders, to plan picking and preparation.
export function preparationTotals(orders: Order[]): PreparationLine[] {
  const totals = new Map<string, PreparationLine>();
  for (const order of orders) {
    for (const line of order.order_items) {
      const key = line.product_id ?? `${line.product_name_snapshot}|${line.unit_snapshot}`;
      const current = totals.get(key) ?? { key, name: line.product_name_snapshot, unit: line.unit_snapshot, quantity: 0, orders: 0 };
      current.quantity += Number(line.quantity);
      current.orders += 1;
      totals.set(key, current);
    }
  }
  return [...totals.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}
