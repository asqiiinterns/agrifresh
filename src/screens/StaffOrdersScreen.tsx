import { useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { supabase } from "../lib/supabase";
import { formatClientNumber } from "../data/account";
import { fetchAllOrders, preparationTotals, staffActions, statusGroups, updateOrderStatus, type OrderStatus, type StaffAction, type StaffOrder } from "../data/staff";
import { Button, Chip, EmptyState, Loading, ScreenHeader, StatusBadge, formatDateTime, formatDay, formatPrice, formatQuantity } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

type View_ = "decide" | "progress" | "prepare" | "done";
const views: { key: View_; label: string }[] = [
  { key: "decide", label: "À décider" },
  { key: "progress", label: "En cours" },
  { key: "prepare", label: "Quantités à préparer" },
  { key: "done", label: "Historique" },
];

export function StaffOrdersScreen() {
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View_>("decide");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function reload(mode: "initial" | "refresh" | "silent") {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
    setError("");
    try {
      setOrders(await fetchAllOrders());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les commandes."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const client = supabase;
    void reload("initial");
    if (!client) return;
    const channel = client
      .channel("staff-orders")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, (payload) => {
        void reload("silent");
        const created = payload.new as { order_number?: number };
        notify("Nouvelle commande", `La commande #${created.order_number ?? ""} attend votre décision.`);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders" }, () => { void reload("silent"); })
      .subscribe();
    return () => { void client.removeChannel(channel); };
  }, []);

  async function apply(order: StaffOrder, action: StaffAction) {
    const reason = reasons[order.id]?.trim() ?? "";
    setUpdatingId(order.id);
    try {
      await updateOrderStatus(order.id, action.status, action.askReason ? reason : undefined);
      setOrders((current) => current.map((item) => item.id === order.id
        ? { ...item, status: action.status, status_note: action.askReason ? reason || null : item.status_note }
        : item));
      setReasons((current) => ({ ...current, [order.id]: "" }));
    } catch (cause) {
      notify("Mise à jour impossible", errorMessage(cause, "Le statut n’a pas pu être modifié."));
      void reload("silent");
    } finally {
      setUpdatingId(null);
    }
  }

  function confirmAction(order: StaffOrder, action: StaffAction) {
    if (action.status !== "declined") {
      void apply(order, action);
      return;
    }
    notify("Décliner la commande", `Décliner la commande #${order.order_number} ? Le stock sera restitué.`, [
      { text: "Retour", style: "cancel" },
      { text: "Décliner", style: "destructive", onPress: () => { void apply(order, action); } },
    ]);
  }

  const counts = useMemo(() => ({
    decide: orders.filter((order) => (statusGroups.decide as readonly string[]).includes(order.status)).length,
    progress: orders.filter((order) => (statusGroups.progress as readonly string[]).includes(order.status)).length,
  }), [orders]);

  const listed = useMemo(() => {
    const group = view === "prepare" ? ["confirmed", "preparing"] : statusGroups[view === "decide" ? "decide" : view === "progress" ? "progress" : "done"];
    const filtered = orders.filter((order) => (group as readonly string[]).includes(order.status));
    // Work queues are ordered by requested delivery day, history by most recent.
    if (view === "done") return filtered;
    return [...filtered].sort((a, b) => (a.requested_delivery_date ?? "9999").localeCompare(b.requested_delivery_date ?? "9999") || a.order_number - b.order_number);
  }, [orders, view]);

  const totals = useMemo(() => preparationTotals(listed), [listed]);

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`ESPACE PERSONNEL · ${counts.decide} À DÉCIDER`} title="Commandes" />
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {views.map((item) => <Chip
          key={item.key}
          label={item.key === "decide" ? `${item.label} (${counts.decide})` : item.key === "progress" ? `${item.label} (${counts.progress})` : item.label}
          selected={view === item.key}
          onPress={() => setView(item.key)}
        />)}
      </ScrollView>
    </View>

    {loading ? <Loading /> : view === "prepare" ? <ScrollView contentContainerStyle={ui.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />}>
      <Text style={[ui.subtitle, { marginTop: 12 }]}>Total des produits pour les {listed.length} commande(s) acceptées ou en préparation.</Text>
      {totals.length === 0 ? <EmptyState title="Rien à préparer" body="Les commandes acceptées apparaîtront ici." /> : <View style={ui.card}>
        {totals.map((line) => <View key={line.key} style={[ui.row, styles.totalRow]}>
          <Text style={[ui.body, { flex: 1 }]}>{line.name}</Text>
          <Text style={ui.small}>{line.orders} cde</Text>
          <Text style={[ui.strong, { minWidth: 90, textAlign: "right" }]}>{formatQuantity(line.quantity)} {line.unit}</Text>
        </View>)}
      </View>}
    </ScrollView> : <FlatList
      data={listed}
      keyExtractor={(order) => order.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune commande" body={view === "decide" ? "Aucune commande n’attend de décision." : view === "progress" ? "Aucune commande en cours." : "L’historique est vide."} />}
      renderItem={({ item }) => {
        const actions = staffActions[item.status as OrderStatus] ?? [];
        const busy = updatingId === item.id;
        const address = item.address_snapshot ?? {};
        const needsReason = actions.some((action) => action.askReason);
        return <View style={ui.card}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]}>#{item.order_number} · {item.clients?.business_name ?? address.business_name ?? address.recipient_name}</Text>
            <StatusBadge status={item.status} />
          </View>
          <Text style={[ui.small, { marginTop: 4 }]}>
            {item.clients ? `${formatClientNumber(item.clients.client_number)} · ` : ""}Reçue le {formatDateTime(item.created_at)}
          </Text>
          <Text style={[ui.body, { marginTop: 4, color: item.requested_delivery_date ? colors.green : colors.muted, fontWeight: "700" }]}>
            Livraison souhaitée : {item.requested_delivery_date ? formatDay(item.requested_delivery_date, { weekday: "long", day: "numeric", month: "long" }) : "dès que possible"}
          </Text>
          <Text style={ui.small}>{address.point_label ? `${address.point_label} — ` : ""}{address.address_line}, {address.city}{address.phone ? ` · ${address.phone}` : ""}</Text>
          {item.customer_note ? <Text style={[ui.body, { color: colors.orange, fontStyle: "italic", marginTop: 4 }]}>« {item.customer_note} »</Text> : null}
          {item.status_note ? <Text style={[ui.small, { color: colors.amber }]}>Motif : {item.status_note}</Text> : null}
          {item.delivered_at ? <Text style={[ui.small, { color: colors.green }]}>Livrée le {formatDateTime(item.delivered_at)}{item.delivered_by_profile?.full_name ? ` par ${item.delivered_by_profile.full_name}` : ""} (scan QR)</Text> : null}

          <View style={ui.divider}>
            {item.order_items.map((line, index) => <View key={`${item.id}-${index}`} style={ui.row}>
              <Text style={[ui.body, { flex: 1 }]}><Text style={{ fontWeight: "800" }}>{formatQuantity(line.quantity)} {line.unit_snapshot}</Text> · {line.product_name_snapshot}</Text>
              <Text style={ui.small}>{formatPrice(line.line_total)}</Text>
            </View>)}
          </View>
          <View style={[ui.row, ui.divider]}><Text style={ui.strong}>Total</Text><Text style={ui.amount}>{formatPrice(item.total)}</Text></View>

          {needsReason ? <TextInput
            value={reasons[item.id] ?? ""}
            onChangeText={(text) => setReasons((current) => ({ ...current, [item.id]: text }))}
            placeholder="Motif pour attente / refus (facultatif, visible par le client)"
            placeholderTextColor={colors.muted}
            style={[ui.input, { marginTop: 10 }]}
          /> : null}
          {actions.length ? <View style={styles.actions}>
            {actions.map((action) => <Button key={action.status} label={action.label} variant={action.variant} busy={busy && action.variant === "primary"} disabled={busy} onPress={() => confirmAction(item, action)} style={action.variant === "primary" ? { flexGrow: 1 } : undefined} />)}
          </View> : item.status === "out_for_delivery" ? <Text style={[ui.small, { marginTop: 10 }]}>En attente du scan du QR code par le livreur.</Text> : null}
        </View>;
      }}
    />}
  </View>;
}

const styles = StyleSheet.create({
  tabs: { paddingHorizontal: 18, paddingVertical: 10, gap: 7 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  totalRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
});
