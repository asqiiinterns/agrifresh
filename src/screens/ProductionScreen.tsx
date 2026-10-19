import { useEffect, useMemo, useState, type ComponentProps, type ReactElement } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";
import { executionQueue, fetchAllOrders, preparationTotals, updateOrderStatus, type StaffOrder } from "../data/staff";
import { Button, Chip, EmptyState, Loading, ScreenHeader, StatusBadge, formatDateTime, formatDay, formatQuantity, toDayKey } from "../ui/components";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { useCan } from "../data/permissions";

type Tab = "totals" | "queue" | "history";

// When the order was marked ready ("Préparée"), from its status history.
const preparedAt = (order: StaffOrder) => [...(order.order_status_history ?? [])]
  .filter((event) => event.status === "ready")
  .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.created_at ?? null;

export function ProductionScreen() {
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("totals");
  const [search, setSearch] = useState("");
  const [delivery, setDelivery] = useState<DateFilterValue>(null);
  const [prepared, setPrepared] = useState<DateFilterValue>(() => presets.today.value());

  async function reload(mode: "initial" | "refresh" | "silent") {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
    setError("");
    try {
      setOrders(await fetchAllOrders());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger la production."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const realtime = supabase;
    void reload("initial");
    if (!realtime) return;
    const channel = realtime
      .channel("production-orders")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => { void reload("silent"); })
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, []);

  const term = search.trim().toLocaleLowerCase("fr");
  const matchesSearch = (order: StaffOrder) => !term
    || `${order.clients?.business_name ?? ""} ${order.address_snapshot?.point_label ?? ""} ${order.order_number} ${order.order_items.map((line) => line.product_name_snapshot).join(" ")}`.toLocaleLowerCase("fr").includes(term);

  const queue = useMemo(() => executionQueue(orders).filter((order) => matchesDate(order.requested_delivery_date, delivery) && matchesSearch(order)), [orders, delivery, term]);
  const toPrepare = queue.filter((order) => order.status === "confirmed" || order.status === "preparing");
  const history = useMemo(() => {
    return orders
      .map((order) => ({ order, at: preparedAt(order) }))
      .filter((entry): entry is { order: StaffOrder; at: string } => entry.at !== null
        && ["ready", "out_for_delivery", "delivered"].includes(entry.order.status)
        && matchesDate(entry.at, prepared)
        && matchesSearch(entry.order))
      .sort((a, b) => b.at.localeCompare(a.at));
  }, [orders, prepared, term]);

  const filters: Filter[] = tab === "history"
    ? [{ kind: "date", title: "Préparées le", presets: [presets.today, presets.yesterday, presets.last7, presets.last30], value: prepared, onChange: setPrepared }]
    : [{ kind: "date", title: "Livraison", presets: [presets.late, presets.today, presets.tomorrow, presets.next7, presets.noDate], value: delivery, onChange: setDelivery }];

  const refresh = <RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`${toPrepare.length} COMMANDE(S) À PRÉPARER`} title="Production" />
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        <Chip label="À préparer (totaux)" selected={tab === "totals"} onPress={() => setTab("totals")} />
        <Chip label={`File d’exécution (${queue.length})`} selected={tab === "queue"} onPress={() => setTab("queue")} />
        <Chip label="Historique" selected={tab === "history"} onPress={() => setTab("history")} />
      </ScrollView>
    </View>
    <FilterBar search={search} onSearch={setSearch} placeholder="Produit, client ou n° de commande" filters={filters} />
    {error ? <Text style={[ui.error, { paddingHorizontal: 18, marginTop: 8 }]}>{error}</Text> : null}

    {loading ? <Loading /> : tab === "totals" ? <TotalsView orders={toPrepare} refreshControl={refresh} />
      : tab === "queue" ? <QueueView queue={queue} refreshControl={refresh} onChanged={() => void reload("silent")} />
      : <FlatList
        data={history}
        keyExtractor={(entry) => entry.order.id}
        contentContainerStyle={ui.content}
        refreshControl={refresh}
        ListHeaderComponent={<Text style={[ui.small, { marginTop: 8 }]}>{history.length} commande(s) préparée(s)</Text>}
        ListEmptyComponent={<EmptyState title="Aucune préparation" body="Aucune commande préparée sur cette période." />}
        renderItem={({ item }) => <View style={ui.card}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]}>#{item.order.order_number} · {item.order.clients?.business_name ?? ""}</Text>
            <StatusBadge status={item.order.status} />
          </View>
          <Text style={[ui.small, { color: colors.green, fontWeight: "700" }]}>Préparée le {formatDateTime(item.at)}</Text>
          <Text style={ui.small} numberOfLines={3}>{item.order.order_items.map((line) => `${formatQuantity(line.quantity)} ${line.unit_snapshot} ${line.product_name_snapshot}`).join(" · ")}</Text>
        </View>}
      />}
  </View>;
}

function TotalsView({ orders, refreshControl }: { orders: StaffOrder[]; refreshControl: ReactElement<ComponentProps<typeof RefreshControl>> }) {
  const totals = useMemo(() => preparationTotals(orders), [orders]);
  const [open, setOpen] = useState<string[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const storageKey = `agrifresh-prep-checks-${toDayKey(new Date())}`;

  // Ticks are a picking aid for the day, kept on this device only.
  useEffect(() => {
    void AsyncStorage.getItem(storageKey).then((stored) => { if (stored) setChecked(JSON.parse(stored) as string[]); }).catch(() => {});
  }, [storageKey]);

  function toggleCheck(key: string) {
    setChecked((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      void AsyncStorage.setItem(storageKey, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }

  const toggleOpen = (key: string) => setOpen((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const done = totals.filter((line) => checked.includes(line.key)).length;

  return <ScrollView contentContainerStyle={ui.content} refreshControl={refreshControl}>
    <Text style={[ui.small, { marginTop: 8 }]}>{orders.length} commande(s) acceptée(s) ou en préparation · {done}/{totals.length} produit(s) cochés. Touchez un produit pour voir les clients.</Text>
    {totals.length === 0 ? <EmptyState title="Rien à préparer" body="Les commandes acceptées apparaîtront ici." /> : <View style={ui.card}>
      {totals.map((line) => {
        const expanded = open.includes(line.key);
        const isChecked = checked.includes(line.key);
        return <View key={line.key} style={styles.totalBlock}>
          <View style={[ui.row, { paddingVertical: 10 }]}>
            <Pressable onPress={() => toggleCheck(line.key)} hitSlop={8} style={[styles.checkbox, isChecked && styles.checkboxChecked]} accessibilityLabel={`Cocher ${line.name}`}>
              {isChecked ? <Text style={styles.checkmark}>✓</Text> : null}
            </Pressable>
            <Pressable onPress={() => toggleOpen(line.key)} style={[ui.row, { flex: 1 }]}>
              <Text style={[ui.body, { flex: 1, fontWeight: expanded ? "800" : "400" }, isChecked && styles.doneText]}>{expanded ? "▾" : "▸"} {line.name}</Text>
              <Text style={ui.small}>{line.clients.length} cl.</Text>
              <Text style={[styles.quantity, isChecked && styles.doneText]}>{formatQuantity(line.quantity)} {line.unit}</Text>
            </Pressable>
          </View>
          {expanded ? <View style={styles.clientList}>
            {line.clients.map((entry) => <View key={entry.key} style={[ui.row, { paddingVertical: 4 }]}>
              <View style={{ flex: 1 }}>
                <Text style={ui.body}>{entry.name}</Text>
                <Text style={ui.small}>Cde {entry.orders.map((number) => `#${number}`).join(", ")}{entry.day ? ` · livraison ${formatDay(entry.day)}` : ""}</Text>
              </View>
              <Text style={[ui.body, { fontWeight: "800" }]}>{formatQuantity(entry.quantity)} {line.unit}</Text>
            </View>)}
          </View> : null}
        </View>;
      })}
    </View>}
  </ScrollView>;
}

function QueueView({ queue, refreshControl, onChanged }: { queue: StaffOrder[]; refreshControl: ReactElement<ComponentProps<typeof RefreshControl>>; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const canUpdate = useCan()("production.update");

  async function advance(order: StaffOrder) {
    setBusyId(order.id);
    try {
      await updateOrderStatus(order.id, order.status === "confirmed" ? "preparing" : "ready");
      onChanged();
    } catch (cause) {
      notify("Production", errorMessage(cause, "Le statut n’a pas pu être modifié."));
    } finally {
      setBusyId(null);
    }
  }

  return <FlatList
    data={queue}
    keyExtractor={(order) => order.id}
    contentContainerStyle={ui.content}
    refreshControl={refreshControl}
    ListHeaderComponent={<Text style={[ui.small, { marginTop: 8 }]}>Ordre fixé par l’administration : préparez de haut en bas.</Text>}
    ListEmptyComponent={<EmptyState title="File vide" body="Aucune commande acceptée pour le moment." />}
    renderItem={({ item, index }) => <View style={[ui.card, item.status === "preparing" && styles.activeCard]}>
      <View style={ui.row}>
        <Text style={styles.position}>{index + 1}</Text>
        <Text style={[ui.strong, { flex: 1 }]}>#{item.order_number} · {item.clients?.business_name ?? ""}</Text>
        <StatusBadge status={item.status} />
      </View>
      <Text style={[ui.small, { marginTop: 3 }]}>{item.requested_delivery_date ? `Livraison ${formatDay(item.requested_delivery_date)}` : "Dès que possible"}{item.address_snapshot?.point_label ? ` · ${item.address_snapshot.point_label}` : ""}</Text>
      <View style={ui.divider}>
        {item.order_items.map((line, lineIndex) => <Text key={`${item.id}-${lineIndex}`} style={ui.body}><Text style={{ fontWeight: "800" }}>{formatQuantity(line.quantity)} {line.unit_snapshot}</Text> · {line.product_name_snapshot}</Text>)}
      </View>
      {item.customer_note ? <Text style={[ui.small, { color: colors.orange, marginTop: 4 }]}>« {item.customer_note} »</Text> : null}
      {item.status === "ready" ? <Text style={[ui.small, { marginTop: 8, color: colors.green, fontWeight: "700" }]}>Prête · en attente d’expédition</Text>
        : !canUpdate ? null : <Button label={item.status === "confirmed" ? "COMMENCER LA PRÉPARATION" : "MARQUER PRÊTE"} onPress={() => void advance(item)} busy={busyId === item.id} style={{ marginTop: 10 }} />}
    </View>}
  />;
}

const styles = StyleSheet.create({
  tabs: { paddingHorizontal: 18, paddingVertical: 8, gap: 7 },
  totalBlock: { borderBottomWidth: 1, borderBottomColor: colors.line },
  clientList: { paddingLeft: 34, paddingBottom: 10, gap: 2 },
  quantity: { color: colors.text, fontSize: 14, fontWeight: "800", minWidth: 92, textAlign: "right" },
  checkbox: { width: 26, height: 26, borderRadius: 6, borderWidth: 2, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: colors.green, borderColor: colors.green },
  checkmark: { color: colors.white, fontWeight: "800" },
  doneText: { color: colors.muted, textDecorationLine: "line-through" },
  activeCard: { borderColor: "#2f5d8a", backgroundColor: "#f3f7fb" },
  position: { minWidth: 26, height: 26, borderRadius: 13, backgroundColor: colors.green, color: colors.white, textAlign: "center", lineHeight: 26, fontWeight: "800", paddingHorizontal: 4 },
});
