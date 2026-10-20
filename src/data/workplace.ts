import { Platform } from "react-native";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { supabase } from "../lib/supabase";
import { ORDER_FIELDS } from "./orders";
import type { StaffOrder } from "./staff";

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

// ---------------------------------------------------------------------------
// Location: shared only with consent, only while the app is open
// ---------------------------------------------------------------------------

export type TeamLocation = { user_id: string; name: string; role: string; consent: boolean; latitude: number | null; longitude: number | null; accuracy: number | null; updated_at: string | null; last_sign_in_at: string | null };

export async function fetchMyLocationConsent(): Promise<boolean> {
  const { data: auth } = await client().auth.getUser();
  if (!auth.user) return false;
  const { data } = await client().from("profiles").select("location_consent").eq("id", auth.user.id).maybeSingle();
  return Boolean((data as { location_consent?: boolean } | null)?.location_consent);
}

export async function setLocationConsent(consent: boolean): Promise<void> {
  if (consent && Platform.OS !== "web") {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) throw new Error("Autorisez la localisation « pendant l’utilisation » dans les réglages du téléphone.");
  }
  const { error } = await client().rpc("set_location_consent", { p_consent: consent });
  if (error) throw error;
  if (consent) await sendMyLocation();
}

// Sends the current position if this account shares it; never asks for permission here.
export async function sendMyLocation(): Promise<void> {
  try {
    if (Platform.OS === "web") {
      if (typeof navigator === "undefined" || !navigator.geolocation) return;
      const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 }));
      await client().rpc("update_my_location", { p_latitude: position.coords.latitude, p_longitude: position.coords.longitude, p_accuracy: position.coords.accuracy });
      return;
    }
    const permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) return;
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    await client().rpc("update_my_location", { p_latitude: position.coords.latitude, p_longitude: position.coords.longitude, p_accuracy: position.coords.accuracy });
  } catch {
    // Best effort: no position this time.
  }
}

export async function fetchTeamLocations(): Promise<TeamLocation[]> {
  const { data, error } = await client().rpc("team_locations");
  if (error) throw error;
  return (data ?? []) as TeamLocation[];
}

// ---------------------------------------------------------------------------
// Reminders (with a local alarm on this phone)
// ---------------------------------------------------------------------------

export type Reminder = { id: string; title: string; note: string | null; remind_at: string; done: boolean; order_id: string | null };

export async function fetchReminders(): Promise<Reminder[]> {
  const { data, error } = await client().from("reminders").select("id, title, note, remind_at, done, order_id").order("remind_at").limit(500);
  if (error) throw error;
  return (data ?? []) as Reminder[];
}

export async function createReminder(input: { title: string; note: string; remindAt: Date }): Promise<void> {
  const { data: auth } = await client().auth.getUser();
  if (!auth.user) throw new Error("Session expirée.");
  const { error } = await client().from("reminders").insert({ user_id: auth.user.id, title: input.title.trim(), note: input.note.trim() || null, remind_at: input.remindAt.toISOString() });
  if (error) throw error;
  await scheduleAlarm(input.title.trim(), input.note.trim(), input.remindAt);
}

export async function setReminderDone(id: string, done: boolean): Promise<void> {
  const { error } = await client().from("reminders").update({ done }).eq("id", id);
  if (error) throw error;
}

export async function deleteReminder(id: string): Promise<void> {
  const { error } = await client().from("reminders").delete().eq("id", id);
  if (error) throw error;
}

// Alarm on the phone at the reminder time (the reminder stays visible in the calendar anyway).
async function scheduleAlarm(title: string, body: string, date: Date) {
  if (Platform.OS === "web" || date.getTime() <= Date.now()) return;
  try {
    const permission = await Notifications.getPermissionsAsync();
    const granted = permission.granted || (permission.canAskAgain && (await Notifications.requestPermissionsAsync()).granted);
    if (!granted) return;
    await Notifications.scheduleNotificationAsync({
      content: { title: `⏰ ${title}`, body: body || "Rappel Appro+", sound: "default" },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date, channelId: "alerts" },
    });
  } catch {
    // The reminder is still saved.
  }
}

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

export type LeaveKind = "paid" | "sick" | "unpaid" | "training" | "other";
export type Leave = { id: string; user_id: string; name: string; kind: LeaveKind; start_date: string; end_date: string; half_day: boolean; note: string | null; status: "pending" | "approved" | "refused" | "cancelled"; decision_note: string | null; created_at: string; mine: boolean };
export const leaveKinds: { key: LeaveKind; label: string }[] = [
  { key: "paid", label: "Congé payé" },
  { key: "sick", label: "Maladie" },
  { key: "unpaid", label: "Sans solde" },
  { key: "training", label: "Formation" },
  { key: "other", label: "Autre" },
];
export const leaveKindLabel = (kind: string) => leaveKinds.find((item) => item.key === kind)?.label ?? kind;
export const leaveStatusStyle = {
  pending: { label: "En attente", color: "#7a5a12", background: "#fbefc9" },
  approved: { label: "Accepté", color: "#1d6b36", background: "#d6efdc" },
  refused: { label: "Refusé", color: "#a63d2f", background: "#f8e2dd" },
  cancelled: { label: "Annulé", color: "#5f6560", background: "#e9eae7" },
};

export async function fetchLeaves(from: string, to: string): Promise<Leave[]> {
  const { data, error } = await client().rpc("leave_list", { p_from: from, p_to: to });
  if (error) throw error;
  return (data ?? []) as Leave[];
}

export async function requestLeave(kind: LeaveKind, start: string, end: string, halfDay: boolean, note: string): Promise<"approved" | "pending"> {
  const { data, error } = await client().rpc("request_leave", { p_kind: kind, p_start: start, p_end: end, p_half_day: halfDay, p_note: note.trim() || null });
  if (error) throw error;
  return (data as { status: "approved" | "pending" }).status;
}

export async function decideLeave(id: string, action: "approve" | "refuse" | "cancel", note = ""): Promise<void> {
  const { error } = await client().rpc("decide_leave", { p_id: id, p_action: action, p_note: note.trim() || null });
  if (error) throw error;
}

export async function fetchLeaveApproval(): Promise<boolean> {
  const { data } = await client().from("app_settings").select("leave_approval_required").eq("id", 1).maybeSingle();
  return (data as { leave_approval_required?: boolean } | null)?.leave_approval_required ?? true;
}

export async function setLeaveApproval(required: boolean): Promise<void> {
  const { error } = await client().rpc("admin_set_leave_approval", { p_required: required });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export type Incident = { id: string; kind: "delivery" | "vehicle"; category: string; description: string; order_id: string | null; vehicle_id: string | null; status: "open" | "resolved"; resolution: string | null; created_at: string; resolved_at: string | null; reporter: { full_name: string } | null; vehicles: { label: string } | null; orders: { order_number: number } | null };
export const incidentCategories = {
  delivery: ["Client absent", "Adresse introuvable", "Produit abîmé", "Produit manquant", "Refus de livraison", "Retard", "Autre"],
  vehicle: ["Panne", "Crevaison", "Accident", "Froid / frigo", "Carburant", "Autre"],
};

export async function fetchIncidents(): Promise<Incident[]> {
  const { data, error } = await client().from("incidents")
    .select("id, kind, category, description, order_id, vehicle_id, status, resolution, created_at, resolved_at, reporter:profiles!incidents_reported_by_fkey(full_name), vehicles(label), orders(order_number)")
    .order("created_at", { ascending: false }).limit(300);
  if (error) throw error;
  return (data ?? []) as unknown as Incident[];
}

export async function reportIncident(kind: Incident["kind"], category: string, description: string, orderId: string | null, vehicleId: string | null): Promise<void> {
  const { error } = await client().rpc("report_incident", { p_kind: kind, p_category: category, p_description: description, p_order_id: orderId, p_vehicle_id: vehicleId });
  if (error) throw error;
}

export async function resolveIncident(id: string, resolution: string): Promise<void> {
  const { error } = await client().rpc("resolve_incident", { p_id: id, p_resolution: resolution });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Statistics: orders of a period with their history
// ---------------------------------------------------------------------------

export async function fetchOrdersSince(since: string): Promise<StaffOrder[]> {
  const { data, error } = await client().from("orders")
    .select(`${ORDER_FIELDS}, clients(business_name, client_number, show_prices, show_origin)`)
    .gte("created_at", since).order("created_at").limit(5000);
  if (error) throw error;
  return (data ?? []) as unknown as StaffOrder[];
}
