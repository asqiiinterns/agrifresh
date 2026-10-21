import { useEffect, useMemo, useState, type ComponentProps, type ReactElement } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
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

// Client name: the record's name, or the one saved on the order.
const clientOf = (order: StaffOrder) => order.clients?.business_name ?? order.address_snapshot?.business_name ?? "Client";

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
      setOrders(await fetchAllOrders(mode !== "initial"));
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

  const refresh = <RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.primary} />;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`${toPrepare.length} COMMANDE(S) À PRÉPARER`} title="Production" />
    <View>
      <View style={styles.tabs}>
        <Chip label="À préparer (totaux)" selected={tab === "totals"} onPress={() => setTab("totals")} />
        <Chip label={`File d’exécution (${toPrepare.length})`} selected={tab === "queue"} onPress={() => setTab("queue")} />
        <Chip label="Historique" selected={tab === "history"} onPress={() => setTab("history")} />
      </View>
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
            <View style={{ flex: 1 }}>
              <Text style={styles.clientName} numberOfLines={1}>{clientOf(item.order)}</Text>
              <Text style={ui.small}>Commande #{item.order.order_number}</Text>
            </View>
            <StatusBadge status={item.order.status} />
          </View>
          <Text style={[ui.small, { color: colors.primary, fontWeight: "700" }]}>Préparée le {formatDateTime(item.at)}</Text>
          <Text style={ui.small} numberOfLines={3}>{item.order.order_items.map((line) => `${formatQuantity(line.quantity)} ${line.unit_snapshot} ${line.product_name_snapshot}`).join(" · ")}</Text>
        </View>}
      />}
  </View>;
}

// Ticking a product ticks every client; unticking one client recalculates what is done.
function TotalsView({ orders, refreshControl }: { orders: StaffOrder[]; refreshControl: ReactElement<ComponentProps<typeof RefreshControl>> }) {
  const totals = useMemo(() => preparationTotals(orders), [orders]);
  const [open, setOpen] = useState<string[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const storageKey = `agrifresh-prep-client-checks-${toDayKey(new Date())}`;

  // Ticks are a picking aid for the day, kept on this device only.
  useEffect(() => {
    void AsyncStorage.getItem(storageKey).then((stored) => { if (stored) setChecked(JSON.parse(stored) as string[]); }).catch(() => {});
  }, [storageKey]);

  const keyOf = (product: string, client: string) => `${product}§${client}`;
  function save(next: string[]) {
    void AsyncStorage.setItem(storageKey, JSON.stringify(next)).catch(() => {});
    return next;
  }
  function toggleProduct(line: (typeof totals)[number]) {
    const keys = line.clients.map((entry) => keyOf(line.key, entry.key));
    setChecked((current) => save(keys.every((key) => current.includes(key)) ? current.filter((key) => !keys.includes(key)) : [...new Set([...current, ...keys])]));
  }
  function toggleClient(line: (typeof totals)[number], clientKey: string) {
    const key = keyOf(line.key, clientKey);
    setChecked((current) => save(current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }

  const toggleOpen = (key: string) => setOpen((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const doneOf = (line: (typeof totals)[number]) => line.clients.filter((entry) => checked.includes(keyOf(line.key, entry.key))).reduce((sum, entry) => sum + entry.quantity, 0);
  const done = totals.filter((line) => line.clients.every((entry) => checked.includes(keyOf(line.key, entry.key)))).length;

  return <ScrollView contentContainerStyle={ui.content} refreshControl={refreshControl}>
    <Text style={[ui.small, { marginTop: 8 }]}>{orders.length} commande(s) acceptée(s) ou en préparation · {done}/{totals.length} produit(s) terminés. Cocher un produit coche tous ses clients ; dépliez pour décocher un client.</Text>
    {totals.length === 0 ? <EmptyState title="Rien à préparer" body="Les commandes acceptées apparaîtront ici." /> : <View style={ui.card}>
      {totals.map((line) => {
        const expanded = open.includes(line.key);
        const made = doneOf(line);
        const all = made >= line.quantity && line.clients.length > 0;
        const partial = made > 0 && !all;
        return <View key={line.key} style={styles.totalBlock}>
          <View style={[ui.row, { paddingVertical: 8 }]}>
            <Pressable onPress={() => toggleProduct(line)} hitSlop={8} style={[styles.checkbox, all && styles.checkboxChecked, partial && styles.checkboxPartial]} accessibilityLabel={`Cocher ${line.name} pour tous les clients`}>
              {all ? <Text style={styles.checkmark}>✓</Text> : partial ? <Text style={[styles.checkmark, { color: colors.primary }]}>–</Text> : null}
            </Pressable>
            <Pressable onPress={() => toggleOpen(line.key)} style={[ui.row, { flex: 1 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[ui.body, { fontWeight: expanded ? "800" : "600" }, all && styles.doneText]}>{expanded ? "▾" : "▸"} {line.name}</Text>
                <Text style={ui.small}>{line.clients.length} client(s){partial ? ` · reste ${formatQuantity(line.quantity - made)} ${line.unit}` : ""}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={[styles.quantity, all && styles.doneText]}>{formatQuantity(line.quantity)} {line.unit}</Text>
                {made > 0 ? <Text style={[ui.small, { color: colors.primary, fontWeight: "800" }]}>fait {formatQuantity(made)}</Text> : null}
              </View>
            </Pressable>
          </View>
          {partial || made > 0 ? <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.min(100, (made / line.quantity) * 100)}%` }]} /></View> : null}
          {expanded ? <View style={styles.clientList}>
            {line.clients.map((entry) => {
              const on = checked.includes(keyOf(line.key, entry.key));
              return <Pressable key={entry.key} onPress={() => toggleClient(line, entry.key)} style={[ui.row, { paddingVertical: 5 }]}>
                <View style={[styles.smallBox, on && styles.checkboxChecked]}>{on ? <Text style={[styles.checkmark, { fontSize: 11 }]}>✓</Text> : null}</View>
                <View style={{ flex: 1 }}>
                  <Text style={[ui.body, on && styles.doneText]}>{entry.name}</Text>
                  <Text style={ui.small}>Cde {entry.orders.map((number) => `#${number}`).join(", ")}{entry.day ? ` · livraison ${formatDay(entry.day)}` : ""}</Text>
                </View>
                <Text style={[ui.body, { fontWeight: "800" }, on && styles.doneText]}>{formatQuantity(entry.quantity)} {line.unit}</Text>
              </Pressable>;
            })}
          </View> : null}
        </View>;
      })}
    </View>}
  </ScrollView>;
}

function QueueView({ queue, refreshControl, onChanged }: { queue: StaffOrder[]; refreshControl: ReactElement<ComponentProps<typeof RefreshControl>>; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  // The step just made is shown at once, and a second tap right after it is ignored (double tap).
  const [local, setLocal] = useState<Record<string, StaffOrder["status"]>>({});
  const canUpdate = useCan()("production.update");
  const statusOf = (order: StaffOrder) => local[order.id] ?? order.status;
  useEffect(() => { setLocal({}); }, [queue]);

  async function advance(order: StaffOrder) {
    if (busyId) return;
    const next = statusOf(order) === "confirmed" ? "preparing" : "ready";
    setBusyId(order.id);
    try {
      await updateOrderStatus(order.id, next);
      setLocal((current) => ({ ...current, [order.id]: next }));
      onChanged();
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
    renderItem={({ item, index }) => { const status = statusOf(item); return <View style={[ui.card, status === "preparing" && styles.activeCard]}>
      <View style={ui.row}>
        <Text style={styles.position}>{index + 1}</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.clientName} numberOfLines={1}>{clientOf(item)}</Text>
          <Text style={ui.small}>Commande #{item.order_number}</Text>
        </View>
        <StatusBadge status={status} />
      </View>
      <Text style={[ui.small, { marginTop: 3 }]}>{item.requested_delivery_date ? `Livraison ${formatDay(item.requested_delivery_date)}` : "Dès que possible"}{item.address_snapshot?.point_label ? ` · ${item.address_snapshot.point_label}` : ""}</Text>
      <View style={ui.divider}>
        {item.order_items.map((line, lineIndex) => <Text key={`${item.id}-${lineIndex}`} style={ui.body}><Text style={{ fontWeight: "800" }}>{formatQuantity(line.quantity)} {line.unit_snapshot}</Text> · {line.product_name_snapshot}</Text>)}
      </View>
      {item.customer_note ? <Text style={[ui.small, { color: colors.orange, marginTop: 4 }]}>« {item.customer_note} »</Text> : null}
      {status === "ready" ? <Text style={[ui.small, { marginTop: 8, color: colors.primary, fontWeight: "700" }]}>Prête · en attente d’expédition</Text>
        : !canUpdate ? null : <Button label={status === "confirmed" ? "COMMENCER LA PRÉPARATION" : "MARQUER PRÊTE"} onPress={() => advance(item)} busy={busyId === item.id} style={{ marginTop: 10 }} />}
    </View>; }}
  />;
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 18, paddingVertical: 8, gap: 7 },
  clientName: { color: colors.text, fontSize: 16, fontWeight: "800" },
  totalBlock: { borderBottomWidth: 1, borderBottomColor: colors.line },
  clientList: { paddingLeft: 34, paddingBottom: 8, gap: 2 },
  quantity: { color: colors.text, fontSize: 14, fontWeight: "800", minWidth: 92, textAlign: "right" },
  checkbox: { width: 26, height: 26, borderRadius: 6, borderWidth: 2, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkboxPartial: { borderColor: colors.primary },
  smallBox: { width: 20, height: 20, borderRadius: 5, borderWidth: 2, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: colors.line, marginBottom: 8, marginLeft: 34 },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: colors.primary },
  checkmark: { color: colors.white, fontWeight: "800" },
  doneText: { color: colors.muted, textDecorationLine: "line-through" },
  activeCard: { borderColor: "#2f5d8a", backgroundColor: "#f3f7fb" },
  position: { minWidth: 26, height: 26, borderRadius: 13, backgroundColor: colors.primary, color: colors.white, textAlign: "center", lineHeight: 26, fontWeight: "800", paddingHorizontal: 4 },
});
