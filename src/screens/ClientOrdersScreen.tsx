import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import type { ClientSummary } from "../data/account";
import { deliveryNoteNumber, fetchMyOrders, shareDeliveryNote, type Order } from "../data/orders";
import { Button, Chip, CloseButton, EmptyState, Loading, ScreenHeader, StatusBadge, formatDateTime, formatDay, formatPrice, formatQuantity, statusLabel } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { QR, QrCode } from "../ui/Qr";
import { colors, ui } from "../ui/theme";

const filters = [
  { key: "all", label: "Toutes", statuses: null },
  { key: "waiting", label: "En attente de réponse", statuses: ["pending", "on_hold"] },
  { key: "accepted", label: "Acceptées / en préparation", statuses: ["confirmed", "preparing", "ready"] },
  { key: "shipped", label: "Expédiées", statuses: ["out_for_delivery"] },
  { key: "delivered", label: "Livrées", statuses: ["delivered"] },
  { key: "refused", label: "Déclinées / annulées", statuses: ["declined", "cancelled"] },
] as const;

export function ClientOrdersScreen({ session, client }: { session: Session; client: ClientSummary }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof filters)[number]["key"]>("all");
  const [receptionVisible, setReceptionVisible] = useState(false);
  const statusesRef = useRef<Record<string, string>>({});

  async function reload(mode: "initial" | "refresh" | "silent") {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
    setError("");
    try {
      const next = await fetchMyOrders();
      statusesRef.current = Object.fromEntries(next.map((order) => [order.id, order.status]));
      setOrders(next);
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les commandes."));
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
      .channel(`customer-orders-${session.user.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders", filter: `customer_id=eq.${session.user.id}` }, (payload) => {
        // With RLS, payload.old only carries the primary key, so compare with the last loaded status.
        const updated = payload.new as { id?: string; order_number?: number; status?: string };
        const previous = updated.id ? statusesRef.current[updated.id] : undefined;
        void reload("silent");
        if (previous && updated.status && previous !== updated.status) {
          notify("Mise à jour de commande", `Commande #${updated.order_number ?? ""} : ${statusLabel(updated.status)}.`);
        }
      })
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, [session.user.id]);

  async function share(order: Order) {
    setSharingId(order.id);
    try {
      await shareDeliveryNote(order, client.show_prices);
    } catch (cause) {
      notify("Bon de livraison", errorMessage(cause, "Impossible de générer le PDF."));
    } finally {
      setSharingId(null);
    }
  }

  const counts = useMemo(() => Object.fromEntries(filters.map((item) => [item.key, item.statuses
    ? orders.filter((order) => (item.statuses as readonly string[]).includes(order.status)).length
    : orders.length])), [orders]);
  const selected = filters.find((item) => item.key === filter)!;
  const visible = selected.statuses ? orders.filter((order) => (selected.statuses as readonly string[]).includes(order.status)) : orders;
  const shippedCount = counts.shipped ?? 0;

  return <View style={ui.screen}>
    <ScreenHeader
      eyebrow="SUIVI EN DIRECT"
      title="Mes commandes"
      right={client.reception_qr && client.reception_token ? <Button label="QR RÉCEPTION" onPress={() => setReceptionVisible(true)} /> : undefined}
    />
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        {filters.map((item) => <Chip key={item.key} label={`${item.label} (${counts[item.key] ?? 0})`} selected={filter === item.key} onPress={() => setFilter(item.key)} />)}
      </ScrollView>
    </View>
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(order) => order.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text>
        : client.reception_qr && shippedCount ? <Text style={[ui.body, styles.banner]}>{shippedCount} commande(s) en route : à l’arrivée du livreur, touchez « QR RÉCEPTION » et présentez le code.</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune commande" body={filter === "all" ? "Vos commandes apparaîtront ici avec leur statut." : "Aucune commande avec ce statut."} />}
      renderItem={({ item }) => <View style={ui.card}>
        <View style={ui.row}><Text style={ui.strong}>Commande #{item.order_number}</Text><StatusBadge status={item.status} /></View>
        <Text style={[ui.small, { marginTop: 4 }]}>
          {deliveryNoteNumber(item)} · passée le {formatDateTime(item.created_at)}
          {item.requested_delivery_date ? ` · livraison souhaitée ${formatDay(item.requested_delivery_date)}` : ""}
        </Text>
        {item.address_snapshot?.point_label ? <Text style={ui.small}>Livraison : {item.address_snapshot.point_label} — {item.address_snapshot.address_line}</Text> : null}
        {item.delivered_at ? <Text style={[ui.small, { color: colors.green }]}>Livrée le {formatDateTime(item.delivered_at)}</Text> : null}
        {item.status_note && (item.status === "declined" || item.status === "on_hold" || item.status === "cancelled") ? <Text style={[ui.body, { color: colors.amber, marginTop: 6 }]}>Motif : {item.status_note}</Text> : null}
        <View style={ui.divider}>
          {item.order_items.map((line, index) => <View key={`${item.id}-${index}`} style={ui.row}>
            <Text style={[ui.body, { flex: 1 }]}>{formatQuantity(line.quantity)} {line.unit_snapshot} · {line.product_name_snapshot}</Text>
            {client.show_prices ? <Text style={ui.small}>{formatPrice(line.line_total)}</Text> : null}
          </View>)}
        </View>
        {client.show_prices ? <View style={[ui.row, ui.divider]}>
          <Text style={ui.strong}>Total HT</Text>
          <Text style={ui.amount}>{formatPrice(item.total)}</Text>
        </View> : null}
        {item.status !== "declined" && item.status !== "cancelled" ? <Button label={sharingId === item.id ? "Préparation du PDF…" : "BON DE LIVRAISON PDF"} variant="secondary" onPress={() => void share(item)} busy={sharingId === item.id} style={{ marginTop: 10, alignSelf: "flex-start" }} /> : null}
      </View>}
    />}

    <Modal visible={receptionVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setReceptionVisible(false)}>
      <SafeAreaView style={ui.modalSafe}>
        <ScreenHeader eyebrow={client.business_name.toLocaleUpperCase("fr")} title="QR de réception" right={<CloseButton onPress={() => setReceptionVisible(false)} />} />
        <ScrollView contentContainerStyle={[ui.content, { alignItems: "center", paddingTop: 24 }]}>
          {client.reception_token ? <QrCode value={QR.client(client.reception_token)} size={280} /> : null}
          <Text style={[ui.body, { textAlign: "center", marginTop: 20 }]}>Présentez ce code au livreur après avoir vérifié votre livraison. Le scan confirme la réception de vos commandes.</Text>
          <Text style={[ui.small, { textAlign: "center", marginTop: 8 }]}>Ne partagez pas ce code : il vaut signature de réception.</Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  filters: { paddingHorizontal: 18, paddingVertical: 10, gap: 7 },
  banner: { marginTop: 12, padding: 12, borderRadius: 8, backgroundColor: "#ece6f6", color: "#5b3f8a" },
});
