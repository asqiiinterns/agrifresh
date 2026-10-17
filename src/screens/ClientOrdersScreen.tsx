import { useEffect, useRef, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { fetchMyOrders, shareOrderReceipt, type Order } from "../data/orders";
import { Button, EmptyState, Loading, ScreenHeader, StatusBadge, formatDateTime, formatDay, formatPrice, formatQuantity, statusLabel } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

export function ClientOrdersScreen({ session }: { session: Session }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [sharingId, setSharingId] = useState<string | null>(null);
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
    const client = supabase;
    void reload("initial");
    if (!client) return;
    const channel = client
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
    return () => { void client.removeChannel(channel); };
  }, [session.user.id]);

  async function share(order: Order) {
    setSharingId(order.id);
    try {
      await shareOrderReceipt(order);
    } catch (cause) {
      notify("Bon de commande", errorMessage(cause, "Impossible de générer le PDF."));
    } finally {
      setSharingId(null);
    }
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="SUIVI EN DIRECT" title="Mes commandes" />
    {loading ? <Loading /> : <FlatList
      data={orders}
      keyExtractor={(order) => order.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Pas encore de commande" body="Vos commandes apparaîtront ici avec leur statut." />}
      renderItem={({ item }) => <View style={ui.card}>
        <View style={ui.row}><Text style={ui.strong}>Commande #{item.order_number}</Text><StatusBadge status={item.status} /></View>
        <Text style={[ui.small, { marginTop: 4 }]}>
          Passée le {formatDateTime(item.created_at)}
          {item.requested_delivery_date ? ` · Livraison souhaitée ${formatDay(item.requested_delivery_date)}` : ""}
        </Text>
        {item.address_snapshot?.point_label ? <Text style={ui.small}>Livraison : {item.address_snapshot.point_label} — {item.address_snapshot.address_line}</Text> : null}
        {item.delivered_at ? <Text style={[ui.small, { color: colors.green }]}>Livrée le {formatDateTime(item.delivered_at)}</Text> : null}
        {item.status_note && (item.status === "declined" || item.status === "on_hold" || item.status === "cancelled") ? <Text style={[ui.body, { color: colors.amber, marginTop: 6 }]}>Motif : {item.status_note}</Text> : null}
        <View style={ui.divider}>
          {item.order_items.map((line, index) => <Text key={`${item.id}-${index}`} style={ui.body}>{formatQuantity(line.quantity)} {line.unit_snapshot} · {line.product_name_snapshot}</Text>)}
        </View>
        <View style={[ui.row, ui.divider]}>
          <Text style={ui.strong}>Total</Text>
          <Text style={ui.amount}>{formatPrice(item.total)}</Text>
        </View>
        <Button label={sharingId === item.id ? "Préparation du PDF…" : "BON DE COMMANDE PDF"} variant="secondary" onPress={() => void share(item)} busy={sharingId === item.id} style={{ marginTop: 10, alignSelf: "flex-start" }} />
      </View>}
    />}
  </View>;
}
