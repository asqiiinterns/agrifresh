import { supabase } from "../lib/supabase";
import { ORDER_FIELDS, type Order } from "./orders";

export type OrderStatus = "pending" | "on_hold" | "confirmed" | "declined" | "awaiting_client" | "preparing" | "ready" | "out_for_delivery" | "delivered" | "cancelled";

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
  declined: [{ status: "awaiting_client", label: "PROPOSER À RECONFIRMER", variant: "secondary", askReason: true }],
  awaiting_client: [{ status: "cancelled", label: "ANNULER", variant: "danger", askReason: true }],
  confirmed: [{ status: "preparing", label: "COMMENCER LA PRÉPARATION", variant: "primary" }],
  preparing: [{ status: "ready", label: "MARQUER PRÉPARÉE", variant: "primary" }],
  ready: [{ status: "out_for_delivery", label: "EXPÉDIER", variant: "primary" }],
};

export const statusGroups = {
  decide: ["pending", "on_hold", "awaiting_client"],
  progress: ["confirmed", "preparing", "ready", "out_for_delivery"],
  done: ["delivered", "declined", "cancelled"],
} as const;

export type StaffOrder = Order & {
  clients: { business_name: string; client_number: number; show_prices: boolean; show_origin: boolean } | null;
  client_invoices: { invoice_number: string | null; status: string } | null;
  delivered_by_profile: { full_name: string } | null;
};

export async function fetchAllOrders(): Promise<StaffOrder[]> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { data, error } = await supabase
    .from("orders")
    .select(`${ORDER_FIELDS}, clients(business_name, client_number, show_prices, show_origin), client_invoices(invoice_number, status), delivered_by_profile:profiles!orders_delivered_by_fkey(full_name)`)
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

export type PreparationClient = { key: string; name: string; quantity: number; orders: number[]; day: string | null };
export type PreparationLine = { key: string; name: string; unit: string; quantity: number; orders: number; clients: PreparationClient[] };

// Totals per product across accepted orders for the production team, with the
// breakdown per client (and delivery point) behind each total.
export function preparationTotals(orders: StaffOrder[]): PreparationLine[] {
  const totals = new Map<string, PreparationLine>();
  for (const order of orders) {
    const clientName = order.clients?.business_name ?? order.address_snapshot?.business_name ?? "Client";
    const point = order.address_snapshot?.point_label;
    const clientKey = `${order.client_id ?? clientName}|${order.delivery_point_id ?? ""}`;
    for (const line of order.order_items) {
      const key = line.product_id ?? `${line.product_name_snapshot}|${line.unit_snapshot}`;
      const product = totals.get(key) ?? { key, name: line.product_name_snapshot, unit: line.unit_snapshot, quantity: 0, orders: 0, clients: [] };
      product.quantity += Number(line.quantity);
      product.orders += 1;
      let entry = product.clients.find((item) => item.key === clientKey);
      if (!entry) {
        entry = { key: clientKey, name: point ? `${clientName} · ${point}` : clientName, quantity: 0, orders: [], day: order.requested_delivery_date };
        product.clients.push(entry);
      }
      entry.quantity += Number(line.quantity);
      entry.orders.push(order.order_number);
      if (order.requested_delivery_date && (!entry.day || order.requested_delivery_date < entry.day)) entry.day = order.requested_delivery_date;
      totals.set(key, product);
    }
  }
  return [...totals.values()]
    .map((line) => ({ ...line, clients: line.clients.sort((a, b) => b.quantity - a.quantity) }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}
