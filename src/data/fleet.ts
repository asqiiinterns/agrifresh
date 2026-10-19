import { supabase } from "../lib/supabase";

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
export async function shipOrders(orderIds: string[], vehicleId: string | null): Promise<{ shipment_number: number; count: number }> {
  const { data, error } = await client().rpc("driver_ship_orders", { p_order_ids: orderIds, p_vehicle_id: vehicleId });
  if (error) throw error;
  return data as { shipment_number: number; count: number };
}

// Hand-over: proof required depends on the client's options (delivery-note scans, client QR).
export async function deliverOrders(orderIds: string[], deliveryTokens: string[], clientQr: { kind: "point" | "client"; token: string } | null): Promise<number> {
  const { data, error } = await client().rpc("driver_deliver", {
    p_order_ids: orderIds,
    p_delivery_tokens: deliveryTokens,
    p_client_qr_kind: clientQr?.kind ?? null,
    p_client_qr_token: clientQr?.token ?? null,
  });
  if (error) throw error;
  return Number(data);
}

export const vehicleName = (vehicle: Pick<Vehicle, "label" | "plate">) => vehicle.plate ? `${vehicle.label} · ${vehicle.plate}` : vehicle.label;
