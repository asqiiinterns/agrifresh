import { supabase } from "../lib/supabase";
import { cacheGet, cacheSet, enqueue, isOnline } from "./offline";
import type { Signature } from "../ui/SignaturePad";

export type Vehicle = { id: string; label: string; plate: string; notes: string; active: boolean };
export type VehicleInput = Pick<Vehicle, "label" | "plate" | "notes" | "active">;

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchVehicles(includeInactive = false): Promise<Vehicle[]> {
  let query = client().from("vehicles").select("id, label, plate, notes, active").order("label");
  if (!includeInactive) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Vehicle[];
}

export async function saveVehicle(id: string | null, input: VehicleInput): Promise<void> {
  const values = { label: input.label.trim(), plate: input.plate.trim(), notes: input.notes.trim(), active: input.active, updated_at: new Date().toISOString() };
  const { error } = id
    ? await client().from("vehicles").update(values).eq("id", id)
    : await client().from("vehicles").insert(values);
  if (error) throw error;
}

// One shipment: the selected prepared orders, loaded in one vehicle.
// Without network the shipment is queued on the phone and sent when the connection comes back.
export async function shipOrders(orderIds: string[], vehicleId: string | null): Promise<{ shipment_number: number | null; count: number; queued?: boolean }> {
  const args = { p_order_ids: orderIds, p_vehicle_id: vehicleId };
  if (!(await isOnline())) {
    await enqueue("ship", "driver_ship_orders", args, `Expédition de ${orderIds.length} bon(s)`);
    const cached = await cacheGet<{ id: string }[]>("pickups");
    if (cached) await cacheSet("pickups", cached.filter((item) => !orderIds.includes(item.id)));
    return { shipment_number: null, count: orderIds.length, queued: true };
  }
  const { data, error } = await client().rpc("driver_ship_orders", args);
  if (error) throw error;
  return data as { shipment_number: number; count: number };
}

// Hand-over: proof required depends on the client's options (delivery-note scans, client QR).
// Returns the number delivered, or -1 when recorded offline (sent and checked when back online).
export type DepositMethod = "cash" | "check" | "transfer" | "other";
export const depositMethods: { key: DepositMethod; label: string }[] = [
  { key: "cash", label: "Espèces" }, { key: "check", label: "Chèque" }, { key: "transfer", label: "Virement" }, { key: "other", label: "Autre" },
];

// deposit: money received by the driver at delivery (goes to the client's account, applied to issued invoices).
export async function deliverOrders(orderIds: string[], deliveryTokens: string[], clientQr: { kind: "point" | "client"; token: string } | null, signature: Signature | null = null, signer = "",
  deposit: { amount: number; method: DepositMethod } | null = null): Promise<number> {
  const base = { p_order_ids: orderIds, p_delivery_tokens: deliveryTokens, p_client_qr_kind: clientQr?.kind ?? null, p_client_qr_token: clientQr?.token ?? null };
  const withDeposit = !!deposit && deposit.amount > 0;
  const rpc = withDeposit ? "driver_deliver_v3" : signature ? "driver_deliver_v2" : "driver_deliver";
  const args = withDeposit ? { ...base, p_signature: signature, p_signer: signer.trim() || null, p_deposit: deposit.amount, p_deposit_method: deposit.method }
    : signature ? { ...base, p_signature: signature, p_signer: signer.trim() || null } : base;
  if (!(await isOnline())) {
    await enqueue("deliver", rpc, args, `Remise de ${Math.max(orderIds.length, deliveryTokens.length)} commande(s)`);
    return -1;
  }
  const { data, error } = await client().rpc(rpc, args);
  if (error) throw error;
  return Number(withDeposit ? (data as { count: number }).count : data);
}

export const vehicleName = (vehicle: Pick<Vehicle, "label" | "plate">) => vehicle.plate ? `${vehicle.label} · ${vehicle.plate}` : vehicle.label;
