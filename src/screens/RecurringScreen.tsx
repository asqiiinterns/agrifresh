import { useEffect, useState } from "react";
import { FlatList, Modal, RefreshControl, ScrollView, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "../ui/Text";
import { supabase } from "../lib/supabase";
import type { Order } from "../data/orders";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ScreenHeader, formatDay, formatQuantity } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

type Item = { product_id: string; quantity: number; name?: string; unit?: string };
export type RecurringOrder = {
  id: string; client_id: string; items: Item[]; delivery_point_id: string | null; weekdays: number[]; lead_days: number;
  next_delivery: string; note: string | null; active: boolean; last_error: string | null; clients: { business_name: string } | null;
};
const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchRecurring(): Promise<RecurringOrder[]> {
  const { data, error } = await client().from("recurring_orders").select("*, clients(business_name)").order("next_delivery");
  if (error) throw error;
  return (data ?? []) as RecurringOrder[];
}

async function saveRecurring(input: { id: string | null; clientId: string | null; items: Item[]; pointId: string | null; weekdays: number[]; leadDays: number; note: string; active: boolean }) {
  const { error } = await client().rpc("save_recurring_order", {
    p_id: input.id, p_client_id: input.clientId, p_items: input.items, p_delivery_point_id: input.pointId,
    p_weekdays: input.weekdays, p_lead_days: input.leadDays, p_note: input.note.trim() || null, p_active: input.active,
  });
  if (error) throw error;
}

// Creates the orders that are due; called when the team opens the app (pg_cron does it hourly when enabled).
export async function runRecurringOrders(): Promise<number> {
  if (!supabase) return 0;
  const { data } = await supabase.rpc("run_recurring_orders");
  return Number(data ?? 0);
}

// Turns an order into a recurring one: same products, chosen delivery days.
export function RecurringModal({ visible, order, existing, onClose, onSaved }: { visible: boolean; order?: Order | null; existing?: RecurringOrder | null; onClose: () => void; onSaved: () => void }) {
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [leadDays, setLeadDays] = useState(1);
  const [note, setNote] = useState("");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    const deliveryDay = order?.requested_delivery_date ? ((new Date(`${order.requested_delivery_date}T12:00:00`).getDay() + 6) % 7) + 1 : null;
    setWeekdays(existing?.weekdays ?? (deliveryDay ? [deliveryDay] : []));
    setLeadDays(existing?.lead_days ?? 1);
    setNote(existing?.note ?? "");
    setActive(existing?.active ?? true);
    setError("");
  }, [visible]);

  const items: Item[] = existing?.items ?? (order?.order_items ?? []).filter((line) => line.product_id).map((line) => ({ product_id: line.product_id!, quantity: Number(line.quantity), name: line.product_name_snapshot, unit: line.unit_snapshot }));

  async function save() {
    setBusy(true);
    setError("");
    try {
      await saveRecurring({ id: existing?.id ?? null, clientId: existing?.client_id ?? order?.client_id ?? null, items, pointId: existing?.delivery_point_id ?? order?.delivery_point_id ?? null, weekdays, leadDays, note, active });
      notify("Commande récurrente", "Enregistrée : chaque commande sera créée automatiquement avant le jour de livraison choisi.");
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "Enregistrement impossible. La migration 20261104 est-elle exécutée ?"));
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="COMMANDE RÉCURRENTE" title={existing ? "Modifier" : "Répéter automatiquement"} right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content}>
        <View style={ui.card}>
          {items.map((line, index) => <Text key={index} style={ui.body}><Text style={{ fontWeight: "800" }}>{formatQuantity(line.quantity)} {line.unit ?? ""}</Text> · {line.name ?? "Produit"}</Text>)}
        </View>
        <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Jours de livraison</Text>
        <View style={[ui.wrapRow, { marginTop: 6 }]}>{DAYS.map((day, index) => <Chip key={day} label={day} selected={weekdays.includes(index + 1)} onPress={() => setWeekdays((current) => current.includes(index + 1) ? current.filter((item) => item !== index + 1) : [...current, index + 1])} />)}</View>
        <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Commande créée</Text>
        <View style={[ui.wrapRow, { marginTop: 6 }]}>
          <Chip label="Le jour même" selected={leadDays === 0} onPress={() => setLeadDays(0)} />
          <Chip label="La veille" selected={leadDays === 1} onPress={() => setLeadDays(1)} />
          <Chip label="2 jours avant" selected={leadDays === 2} onPress={() => setLeadDays(2)} />
          <Chip label="3 jours avant" selected={leadDays === 3} onPress={() => setLeadDays(3)} />
        </View>
        <Field label="Remarque jointe à chaque commande (facultatif)" value={note} onChangeText={setNote} />
        <View style={[ui.row, { marginTop: 10 }]}>
          <Text style={[ui.body, { flex: 1 }]}>Active</Text>
          <Switch value={active} onValueChange={setActive} trackColor={{ true: colors.green, false: colors.line }} />
        </View>
        <Text style={[ui.small, { marginTop: 6 }]}>Chaque commande arrive comme une commande normale : elle est acceptée par AgriFresh, et vous pouvez la modifier ou l’annuler.</Text>
        {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
        <Button label="ENREGISTRER" onPress={() => void save()} busy={busy} disabled={weekdays.length === 0 || items.length === 0} style={{ marginTop: 14 }} />
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

// List of recurring orders (the client's own, or all of them for the team).
export function RecurringScreen({ team }: { team: boolean }) {
  const [rows, setRows] = useState<RecurringOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<RecurringOrder | null>(null);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      setRows(await fetchRecurring());
    } catch (cause) {
      notify("Commandes récurrentes", errorMessage(cause, "Chargement impossible. La migration 20261104 est-elle exécutée ?"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  useEffect(() => { void reload(); }, []);

  function remove(row: RecurringOrder) {
    notify("Supprimer la commande récurrente", "Les commandes déjà créées ne sont pas touchées.", [
      { text: "Retour", style: "cancel" },
      { text: "Supprimer", style: "destructive", onPress: () => void client().rpc("delete_recurring_order", { p_id: row.id }).then(() => reload()) },
    ]);
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`${rows.filter((row) => row.active).length} ACTIVE(S)`} title="Commandes récurrentes" />
    {loading ? <Loading /> : <FlatList
      data={rows}
      keyExtractor={(row) => row.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.green} />}
      ListEmptyComponent={<EmptyState title="Aucune commande récurrente" body="Dans une commande, touchez « Répéter automatiquement » pour la recevoir chaque semaine aux jours choisis." />}
      renderItem={({ item }) => <View style={[ui.card, !item.active && { opacity: 0.6 }]}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]}>{team ? item.clients?.business_name ?? "Client" : item.weekdays.map((day) => DAYS[day - 1]).join(", ")}</Text>
          <Text style={[ui.small, { color: item.active ? colors.green : colors.muted, fontWeight: "800" }]}>{item.active ? "ACTIVE" : "EN PAUSE"}</Text>
        </View>
        <Text style={ui.small}>{team ? `${item.weekdays.map((day) => DAYS[day - 1]).join(", ")} · ` : ""}prochaine livraison {formatDay(item.next_delivery)} · créée {item.lead_days === 0 ? "le jour même" : `${item.lead_days} j avant`}</Text>
        <Text style={ui.small} numberOfLines={2}>{item.items.map((line) => `${formatQuantity(line.quantity)} ${line.unit ?? ""} ${line.name ?? ""}`).join(" · ")}</Text>
        {item.last_error ? <Text style={[ui.small, { color: colors.danger }]}>Dernier essai : {item.last_error}</Text> : null}
        <View style={[ui.wrapRow, { marginTop: 8 }]}>
          <Button label="MODIFIER" variant="secondary" onPress={() => setEditing(item)} />
          <Button label="SUPPRIMER" variant="danger" onPress={() => remove(item)} />
        </View>
      </View>}
    />}
    <RecurringModal visible={editing !== null} existing={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />
  </View>;
}
