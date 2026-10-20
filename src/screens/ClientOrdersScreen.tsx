import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "../ui/Text";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import type { ClientSummary } from "../data/account";
import { deliveryNoteNumber, fetchMyOrders, formatOrigin, respondToOrder, shareDeliveryNote, type Order } from "../data/orders";
import { claimReasonLabel, claimReasons, claimStatusStyle, createClaim, fetchClaims, type Claim, type ClaimReason } from "../data/claims";
import { OrderTimeline } from "../ui/OrderTimeline";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";
import { useCan } from "../data/permissions";
import { Button, Chip, CloseButton, EmptyState, Loading, OrderProgress, ScreenHeader, Sheets, StatusBadge, formatDateTime, formatDay, formatPrice, formatQuantity, statusLabel } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { QR, QrCode } from "../ui/Qr";
import { colors, ui } from "../ui/theme";

const closedStatuses = ["delivered", "declined", "cancelled"];
const filters = [
  { key: "all", label: "Toutes", statuses: null },
  { key: "reconfirm", label: "À reconfirmer", statuses: ["awaiting_client"] },
  { key: "waiting", label: "En attente de réponse", statuses: ["pending", "on_hold"] },
  { key: "accepted", label: "Acceptées / en préparation", statuses: ["confirmed", "preparing", "ready"] },
  { key: "shipped", label: "Expédiées", statuses: ["out_for_delivery"] },
  { key: "delivered", label: "Livrées", statuses: ["delivered"] },
  { key: "refused", label: "Déclinées / annulées", statuses: ["declined", "cancelled"] },
] as const;

export function ClientOrdersScreen({ session, client, initialOrderId }: { session: Session; client: ClientSummary; initialOrderId?: string }) {
  // Opened from an alert: show that order alone (expanded) until "Voir toutes".
  const [focusId, setFocusId] = useState<string | null>(initialOrderId ?? null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  // Two sheets: orders still moving, and closed ones (history, if AgriFresh enables it).
  const [sheet, setSheet] = useState<"open" | "closed">("open");
  const [expanded, setExpanded] = useState<string[]>(initialOrderId ? [initialOrderId] : []);
  const historyEnabled = client.history_enabled !== false;
  const [placed, setPlaced] = useState<DateFilterValue>(null);
  const [search, setSearch] = useState("");
  const [receptionVisible, setReceptionVisible] = useState(false);
  const statusesRef = useRef<Record<string, string>>({});
  const [claims, setClaims] = useState<Claim[]>([]);
  const [claimOrder, setClaimOrder] = useState<Order | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const canClaim = useCan()("client.claims");

  async function answer(order: Order, accept: boolean) {
    setRespondingId(order.id);
    try {
      await respondToOrder(order.id, accept);
      notify(accept ? "Commande reconfirmée" : "Commande refusée", accept ? `La commande #${order.order_number} est acceptée et part en préparation.` : `La commande #${order.order_number} est annulée.`);
      void reload("silent");
    } catch (cause) {
      notify("Commande", errorMessage(cause, "Votre réponse n’a pas pu être enregistrée."));
    } finally {
      setRespondingId(null);
    }
  }

  function confirmRefusal(order: Order) {
    notify("Refuser la commande", `Annuler définitivement la commande #${order.order_number} ?`, [
      { text: "Retour", style: "cancel" },
      { text: "Refuser", style: "destructive", onPress: () => void answer(order, false) },
    ]);
  }

  async function reload(mode: "initial" | "refresh" | "silent") {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
    setError("");
    try {
      const [next, nextClaims] = await Promise.all([fetchMyOrders(), fetchClaims().catch(() => [] as Claim[])]);
      setClaims(nextClaims);
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
      await shareDeliveryNote(order, { showPrices: client.show_prices, showOrigin: client.show_origin });
    } catch (cause) {
      notify("Bon de livraison", errorMessage(cause, "Impossible de générer le PDF."));
    } finally {
      setSharingId(null);
    }
  }

  const counts = useMemo(() => Object.fromEntries(filters.map((item) => [item.key, item.statuses
    ? orders.filter((order) => (item.statuses as readonly string[]).includes(order.status)).length
    : orders.length])), [orders]);
  const selected = filters.find((item) => item.key === filter) ?? filters[0];
  const term = search.trim().toLocaleLowerCase("fr");
  const inSheet = (order: Order) => closedStatuses.includes(order.status) === (sheet === "closed");
  const focused = focusId ? orders.find((order) => order.id === focusId) ?? null : null;
  const visible = focused ? [focused] : orders.filter((order) => inSheet(order) && (!selected.statuses || (selected.statuses as readonly string[]).includes(order.status))
    && matchesDate(order.created_at, placed)
    && (!term || `${order.order_number} ${order.order_items.map((line) => line.product_name_snapshot).join(" ")}`.toLocaleLowerCase("fr").includes(term)));
  const listFilters: Filter[] = [
    { kind: "choice", title: "Statut", options: filters.filter((item) => !item.statuses || item.statuses.some((status) => closedStatuses.includes(status) === (sheet === "closed"))).map((item) => ({ key: item.key, label: item.label, count: item.statuses ? counts[item.key] ?? 0 : orders.filter(inSheet).length })), value: filter, defaultValue: "all", onChange: setFilter },
    { kind: "date", title: "Passée le", presets: [presets.today, presets.yesterday, presets.last7, presets.last30], value: placed, onChange: setPlaced },
  ];
  const shippedCount = counts.shipped ?? 0;

  return <View style={ui.screen}>
    <ScreenHeader
      eyebrow="SUIVI EN DIRECT"
      title="Mes commandes"
      right={client.reception_qr && client.reception_token ? <Button label="QR RÉCEPTION" onPress={() => setReceptionVisible(true)} /> : undefined}
    />
    {historyEnabled ? <Sheets
      items={[{ key: "open", label: "En cours", count: orders.filter((order) => !closedStatuses.includes(order.status)).length }, { key: "closed", label: "Clôturées", count: orders.filter((order) => closedStatuses.includes(order.status)).length }]}
      value={sheet}
      onChange={(next) => { setSheet(next); setFilter("all"); }}
    /> : null}
    <FilterBar search={search} onSearch={setSearch} placeholder="N° de commande ou produit" filters={listFilters} />
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(order) => order.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text>
        : focused ? <View style={[ui.row, styles.focusBar]}>
          <Text style={[ui.small, { flex: 1, color: colors.text }]}>Commande #{focused.order_number} ouverte depuis une alerte.</Text>
          <Button label="VOIR TOUTES" variant="secondary" onPress={() => { setFocusId(null); setSheet(closedStatuses.includes(focused.status) ? "closed" : "open"); }} />
        </View>
        : client.reception_qr && shippedCount ? <Text style={[ui.body, styles.banner]}>{shippedCount} commande(s) en route : à l’arrivée du livreur, touchez « QR RÉCEPTION » et présentez le code.</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune commande" body={filter === "all" ? "Vos commandes apparaîtront ici avec leur statut." : "Aucune commande avec ce statut."} />}
      renderItem={({ item }) => {
        const open = item.status === "awaiting_client" || expanded.includes(item.id);
        return <View style={ui.card}>
        <Pressable onPress={() => setExpanded((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}>
          <View style={ui.row}><Text style={ui.strong}>{open ? "▾" : "▸"} Commande #{item.order_number}</Text><StatusBadge status={item.status} /></View>
          {!open ? <Text style={[ui.small, { marginTop: 2 }]}>{formatDateTime(item.created_at)} · {item.order_items.length} produit(s){client.show_prices ? ` · ${formatPrice(item.total)}` : ""}</Text> : null}
          <OrderProgress status={item.status} />
        </Pressable>
        {open ? <>
        <Text style={[ui.small, { marginTop: 4 }]}>
          {deliveryNoteNumber(item)} · passée le {formatDateTime(item.created_at)}
          {item.requested_delivery_date ? ` · livraison souhaitée ${formatDay(item.requested_delivery_date)}` : ""}
        </Text>
        {item.address_snapshot?.point_label ? <Text style={ui.small}>Livraison : {item.address_snapshot.point_label} — {item.address_snapshot.address_line}</Text> : null}
        {item.delivered_at ? <Text style={[ui.small, { color: colors.green }]}>Livrée le {formatDateTime(item.delivered_at)}</Text> : null}
        {item.status === "awaiting_client" ? <View style={styles.reconfirm}>
          <Text style={[ui.strong, { color: "#9a4f0f" }]}>AgriFresh vous propose de reconfirmer cette commande</Text>
          {item.status_note ? <Text style={[ui.body, { marginTop: 4 }]}>{item.status_note}</Text> : null}
          <View style={[ui.wrapRow, { marginTop: 10 }]}>
            <Button label="RECONFIRMER" onPress={() => void answer(item, true)} busy={respondingId === item.id} style={{ flexGrow: 1 }} />
            <Button label="REFUSER" variant="danger" onPress={() => confirmRefusal(item)} disabled={respondingId === item.id} />
          </View>
        </View> : item.status_note && (item.status === "declined" || item.status === "on_hold" || item.status === "cancelled") ? <Text style={[ui.body, { color: colors.amber, marginTop: 6 }]}>Motif : {item.status_note}</Text> : null}
        <View style={ui.divider}>
          {item.order_items.map((line, index) => <View key={`${item.id}-${index}`} style={ui.row}>
            <View style={{ flex: 1 }}>
              <Text style={ui.body}>{formatQuantity(line.quantity)} {line.unit_snapshot} · {line.product_name_snapshot}</Text>
              {client.show_origin && line.origin_snapshot ? <Text style={styles.origin}>Origine : {formatOrigin(line.origin_snapshot)}{line.origin_snapshot.label ? ` · ${line.origin_snapshot.label}` : ""}</Text> : null}
            </View>
            {client.show_prices ? <Text style={ui.small}>{formatPrice(line.line_total)}</Text> : null}
          </View>)}
        </View>
        {client.show_prices ? <View style={[ui.row, ui.divider]}>
          <Text style={ui.strong}>Total HT</Text>
          <Text style={ui.amount}>{formatPrice(item.total)}</Text>
        </View> : null}
        {claims.filter((claim) => claim.order_id === item.id).map((claim) => <View key={claim.id} style={styles.claim}>
          <View style={ui.row}>
            <Text style={[ui.small, { fontWeight: "800", color: colors.text, flex: 1 }]}>Réclamation n° {claim.claim_number} · {claimReasonLabel(claim.reason)}</Text>
            <View style={[ui.badge, { backgroundColor: claimStatusStyle[claim.status].background }]}><Text style={[ui.badgeText, { color: claimStatusStyle[claim.status].color }]}>{claimStatusStyle[claim.status].label}</Text></View>
          </View>
          <Text style={ui.small}>{claim.description}</Text>
          {claim.staff_response ? <Text style={[ui.body, { marginTop: 4 }]}>Réponse AgriFresh : {claim.staff_response}</Text> : null}
        </View>)}
        {historyEnabled ? <OrderTimeline order={item} viewer="client" /> : null}
        {item.status !== "declined" && item.status !== "cancelled" && item.status !== "awaiting_client" ? <View style={[ui.wrapRow, { marginTop: 10 }]}>
          <Button label={sharingId === item.id ? "Préparation…" : "BON DE LIVRAISON"} variant="secondary" onPress={() => void share(item)} busy={sharingId === item.id} />
          {canClaim ? <Button label="SIGNALER UN PROBLÈME" variant="secondary" onPress={() => setClaimOrder(item)} /> : null}
        </View> : null}
        </> : null}
      </View>;
      }}
    />}

    <ClaimModal order={claimOrder} onClose={() => setClaimOrder(null)} onSent={() => { setClaimOrder(null); void reload("silent"); }} />

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

function ClaimModal({ order, onClose, onSent }: { order: Order | null; onClose: () => void; onSent: () => void }) {
  const [reason, setReason] = useState<ClaimReason | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!order) return;
    setReason(null);
    setDescription("");
    setError("");
  }, [order]);

  async function send() {
    if (!order) return;
    if (!reason || !description.trim()) {
      setError("Choisissez un motif et décrivez le problème.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createClaim(order.id, reason, description);
      notify("Réclamation envoyée", "AgriFresh vous répondra ici dès son traitement.");
      onSent();
    } catch (cause) {
      setError(errorMessage(cause, "La réclamation n’a pas pu être envoyée."));
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={order !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow={order ? `COMMANDE #${order.order_number}` : ""} title="Signaler un problème" right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <Text style={[ui.strong, { marginTop: 14 }]}>Motif</Text>
        <View style={[ui.wrapRow, { marginTop: 8 }]}>
          {claimReasons.map((item) => <Chip key={item.key} label={item.label} selected={reason === item.key} onPress={() => setReason(item.key)} />)}
        </View>
        <Text style={[ui.strong, { marginTop: 16 }]}>Description</Text>
        <TextInput value={description} onChangeText={setDescription} placeholder="Produits concernés, quantités, état constaté…" placeholderTextColor={colors.muted} style={[ui.input, { minHeight: 110, textAlignVertical: "top", marginTop: 8 }]} multiline maxLength={2000} />
        {order ? <Text style={[ui.small, { marginTop: 10 }]}>Produits de la commande : {order.order_items.map((line) => line.product_name_snapshot).join(", ")}</Text> : null}
        {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
        <Button label="ENVOYER LA RÉCLAMATION" onPress={() => void send()} busy={busy} style={{ marginTop: 16 }} />
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  focusBar: { marginTop: 8, padding: 8, borderRadius: 8, backgroundColor: "#f3f8f1", borderWidth: 1, borderColor: colors.green },
  reconfirm: { marginTop: 10, padding: 12, borderRadius: 8, backgroundColor: "#fde7d4" },
  claim: { marginTop: 10, padding: 10, borderRadius: 8, backgroundColor: colors.cream },
  origin: { color: colors.green, fontSize: 10, marginTop: 1 },
  filters: { paddingHorizontal: 18, paddingVertical: 10, gap: 7 },
  banner: { marginTop: 12, padding: 12, borderRadius: 8, backgroundColor: "#ece6f6", color: "#5b3f8a" },
});
