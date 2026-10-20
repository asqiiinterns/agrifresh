import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import { fetchInvoices } from "../data/invoices";
import { useCan } from "../data/permissions";
import { fetchAllOrders } from "../data/staff";
import { createReminder, deleteReminder, fetchLeaves, fetchReminders, leaveKindLabel, setReminderDone, type Leave, type Reminder } from "../data/workplace";
import { Button, CloseButton, Field, Loading, ScreenHeader, formatDay, statusLabel, statusStyles, toDayKey } from "../ui/components";
import { useNav, type IconName, type NavParams, type TabKey } from "../ui/navigation";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { appLocale } from "../ui/i18n";

type CalendarEvent = { key: string; day: string; time?: string; title: string; detail?: string; color: string; icon: IconName; tab?: TabKey; params?: NavParams; reminder?: Reminder };
const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];

// Everything with a date, in one month view: deliveries, invoice due dates, absences, personal reminders.
export function CalendarScreen() {
  const can = useCan();
  const { navigate } = useNav();
  const [month, setMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const [selected, setSelected] = useState(toDayKey(new Date()));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    const from = toDayKey(new Date(month.getFullYear(), month.getMonth() - 1, 1));
    const to = toDayKey(new Date(month.getFullYear(), month.getMonth() + 2, 0));
    const [orders, invoices, leaves, reminders] = await Promise.all([
      can("orders.view") ? fetchAllOrders().catch(() => []) : Promise.resolve([]),
      can("invoices.manage") ? fetchInvoices().catch(() => []) : Promise.resolve([]),
      fetchLeaves(from, to).catch(() => [] as Leave[]),
      fetchReminders().catch(() => [] as Reminder[]),
    ]);
    const next: CalendarEvent[] = [];
    for (const order of orders) {
      if (!order.requested_delivery_date || ["declined", "cancelled"].includes(order.status)) continue;
      next.push({ key: `o-${order.id}`, day: order.requested_delivery_date, title: `Livraison · ${order.clients?.business_name ?? "Client"}`, detail: `#${order.order_number} · ${statusLabel(order.status)}`, color: statusStyles[order.status]?.color ?? colors.primary, icon: "car-outline", tab: "orders", params: { orderId: order.id, back: "calendar" } });
    }
    for (const invoice of invoices) {
      if (invoice.status !== "issued" || !invoice.due_date) continue;
      next.push({ key: `i-${invoice.id}`, day: invoice.due_date.slice(0, 10), title: `Échéance · ${invoice.invoice_number}`, detail: invoice.client_snapshot.business_name, color: colors.amber, icon: "document-text-outline", tab: "invoices", params: { back: "calendar" } });
    }
    for (const leave of leaves.filter((item) => item.status === "approved" || (item.mine && item.status === "pending"))) {
      const start = new Date(`${leave.start_date}T12:00:00`);
      const end = new Date(`${leave.end_date}T12:00:00`);
      for (let day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
        next.push({ key: `l-${leave.id}-${toDayKey(day)}`, day: toDayKey(day), title: `Absence · ${leave.name}`, detail: `${leaveKindLabel(leave.kind)}${leave.status === "pending" ? " (en attente)" : ""}`, color: "#76289f", icon: "airplane-outline", tab: "leaves", params: { back: "calendar" } });
      }
    }
    for (const reminder of reminders) {
      const at = new Date(reminder.remind_at);
      next.push({ key: `r-${reminder.id}`, day: toDayKey(at), time: at.toLocaleTimeString(appLocale(), { hour: "2-digit", minute: "2-digit" }), title: reminder.title, detail: reminder.note ?? undefined, color: colors.orange, icon: "alarm-outline", reminder });
    }
    setEvents(next);
    setLoading(false);
    setRefreshing(false);
  }

  useEffect(() => { void reload(); }, [month.getTime()]);

  const cells = useMemo(() => {
    const offset = (month.getDay() + 6) % 7;
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const list: (string | null)[] = Array.from({ length: offset }, () => null);
    for (let day = 1; day <= count; day += 1) list.push(toDayKey(new Date(month.getFullYear(), month.getMonth(), day)));
    while (list.length % 7) list.push(null);
    return list;
  }, [month]);
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) map.set(event.day, [...(map.get(event.day) ?? []), event]);
    return map;
  }, [events]);
  const today = toDayKey(new Date());
  const dayEvents = (byDay.get(selected) ?? []).sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));

  async function toggleDone(reminder: Reminder) {
    try {
      await setReminderDone(reminder.id, !reminder.done);
      void reload();
    } catch (cause) {
      notify("Rappel", errorMessage(cause, "Modification impossible."));
    }
  }

  function remove(reminder: Reminder) {
    notify("Supprimer le rappel", reminder.title, [
      { text: "Retour", style: "cancel" },
      { text: "Supprimer", style: "destructive", onPress: () => void deleteReminder(reminder.id).then(() => reload()).catch((cause: unknown) => notify("Rappel", errorMessage(cause, "Suppression impossible."))) },
    ]);
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="LIVRAISONS · ÉCHÉANCES · ABSENCES · RAPPELS" title="Calendrier" right={<Button label="+ RAPPEL" onPress={() => setAdding(true)} />} />
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}>
      <View style={[ui.row, { marginTop: 10 }]}>
        <Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} hitSlop={10}><Ionicons name="chevron-back" size={22} color={colors.primary} /></Pressable>
        <Text style={[ui.strong, { textTransform: "capitalize" }]}>{month.toLocaleDateString(appLocale(), { month: "long", year: "numeric" })}</Text>
        <Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} hitSlop={10}><Ionicons name="chevron-forward" size={22} color={colors.primary} /></Pressable>
      </View>
      <View style={styles.week}>{WEEKDAYS.map((day, index) => <Text key={index} style={styles.weekday}>{day}</Text>)}</View>
      <View style={styles.grid}>
        {cells.map((day, index) => {
          if (!day) return <View key={index} style={styles.cell} />;
          const list = byDay.get(day) ?? [];
          const colorsOfDay = [...new Set(list.map((event) => event.color))].slice(0, 4);
          return <Pressable key={day} onPress={() => setSelected(day)} style={[styles.cell, day === selected && styles.cellSelected]}>
            <Text style={[styles.dayNumber, day === today && styles.today, day === selected && { color: colors.white }]}>{Number(day.slice(8))}</Text>
            <View style={styles.dots}>{colorsOfDay.map((color) => <View key={color} style={[styles.dot, { backgroundColor: day === selected ? colors.white : color }]} />)}</View>
          </Pressable>;
        })}
      </View>
      <Text style={[ui.strong, { marginTop: 14, textTransform: "capitalize" }]}>{formatDay(selected, { weekday: "long", day: "numeric", month: "long" })}</Text>
      {dayEvents.length === 0 ? <Text style={[ui.small, { marginTop: 6 }]}>Rien de prévu ce jour-là.</Text> : dayEvents.map((event) => <Pressable key={event.key} onPress={() => event.tab ? navigate(event.tab, event.params) : undefined} style={[ui.card, styles.event, { borderLeftColor: event.color }, event.reminder?.done && { opacity: 0.55 }]}>
        <Ionicons name={event.icon} size={18} color={event.color} />
        <View style={{ flex: 1 }}>
          <Text style={[ui.strong, event.reminder?.done && { textDecorationLine: "line-through" }]}>{event.time ? `${event.time} · ` : ""}{event.title}</Text>
          {event.detail ? <Text style={ui.small}>{event.detail}</Text> : null}
        </View>
        {event.reminder ? <>
          <Pressable onPress={() => void toggleDone(event.reminder!)} hitSlop={8}><Ionicons name={event.reminder.done ? "checkmark-circle" : "ellipse-outline"} size={22} color={colors.primary} /></Pressable>
          <Pressable onPress={() => remove(event.reminder!)} hitSlop={8}><Ionicons name="trash-outline" size={18} color={colors.danger} /></Pressable>
        </> : <Ionicons name="chevron-forward" size={16} color={colors.muted} />}
      </Pressable>)}
    </ScrollView>}
    <ReminderModal visible={adding} day={selected} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void reload(); }} />
  </View>;
}

function ReminderModal({ visible, day, onClose, onSaved }: { visible: boolean; day: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(day);
  const [time, setTime] = useState("09:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setTitle("");
    setNote("");
    setDate(day);
    setTime("09:00");
    setError("");
  }, [visible]);

  async function save() {
    const at = new Date(`${date}T${time.length === 5 ? time : "09:00"}:00`);
    if (!title.trim() || Number.isNaN(at.getTime())) {
      setError("Donnez un titre, une date (AAAA-MM-JJ) et une heure (HH:MM).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createReminder({ title, note, remindAt: at });
      notify("Rappel enregistré", `Une alarme sonnera sur ce téléphone le ${at.toLocaleString(appLocale(), { dateStyle: "medium", timeStyle: "short" })}.`);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "Le rappel n’a pas pu être enregistré. La migration 20261103 est-elle exécutée ?"));
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="RAPPEL / ALARME" title="Nouveau rappel" right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <Field label="Titre" value={title} onChangeText={setTitle} placeholder="Ex. Relancer le fournisseur" />
        <View style={ui.row}>
          <View style={{ flex: 1 }}><Field label="Date (AAAA-MM-JJ)" value={date} onChangeText={setDate} /></View>
          <View style={{ flex: 1 }}><Field label="Heure (HH:MM)" value={time} onChangeText={setTime} keyboardType="numbers-and-punctuation" /></View>
        </View>
        <Field label="Note (facultatif)" value={note} onChangeText={setNote} multiline />
        {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
        <Button label="ENREGISTRER LE RAPPEL" onPress={() => save()} busy={busy} style={{ marginTop: 14 }} />
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  week: { flexDirection: "row", marginTop: 8 },
  weekday: { flex: 1, textAlign: "center", color: colors.muted, fontSize: 11, fontWeight: "800" },
  grid: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  cell: { width: `${100 / 7}%`, height: 46, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  cellSelected: { backgroundColor: colors.primary },
  dayNumber: { color: colors.text, fontSize: 13, fontWeight: "700" },
  today: { color: colors.orange, fontWeight: "800" },
  dots: { flexDirection: "row", gap: 2, height: 6, marginTop: 2 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  event: { flexDirection: "row", alignItems: "center", gap: 10, borderLeftWidth: 4 },
});
