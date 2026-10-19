import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { fetchDeliveryHistory, fetchPickups, fetchShipments, lookupDeliveryNote, type DeliveredOrder, type Pickup, type ScannedDeliveryNote, type Shipment } from "../data/delivery";
import { deliverOrders } from "../data/fleet";
import { useCan } from "../data/permissions";
import { Button, CloseButton, EmptyState, Loading, ScreenHeader, Sheets, formatDateTime, formatDay, formatQuantity, toDayKey } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { parseQr } from "../ui/Qr";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";
import { ShipModal } from "../ui/ShipModal";
import { colors, ui } from "../ui/theme";

type Tab = "pickup" | "todo" | "history";

export function DriverScreen() {
  const canShip = useCan()("orders.ship");
  const [tab, setTab] = useState<Tab>(canShip ? "pickup" : "todo");
  const [handover, setHandover] = useState<Shipment[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((key) => key + 1);

  const tabs: { key: Tab; label: string }[] = [
    ...(canShip ? [{ key: "pickup" as const, label: "À récupérer" }] : []),
    { key: "todo", label: "À livrer" },
    { key: "history", label: "Historique" },
  ];

  return <View style={ui.screen}>
    <ScreenHeader
      eyebrow="ESPACE LIVREUR"
      title="Livraisons"
      right={tab === "todo" ? <Button label="SCANNER" onPress={() => setHandover([])} /> : undefined}
    />
    <Sheets items={tabs} value={tab} onChange={setTab} />
    {tab === "pickup" ? <PickupList key={`pickup-${refreshKey}`} onShipped={bump} />
      : tab === "todo" ? <ShipmentList key={`todo-${refreshKey}`} onDeliver={setHandover} onDelivered={bump} />
      : <DeliveryHistory key={`history-${refreshKey}`} />}
    <HandoverModal preselected={handover} onClose={() => setHandover(null)} onDelivered={bump} />
  </View>;
}

function Check({ on }: { on: boolean }) {
  return <Ionicons name={on ? "checkbox" : "square-outline"} size={22} color={on ? colors.green : colors.muted} />;
}

// Prepared orders: the driver ticks the delivery notes loaded together, then ships them in one vehicle.
function PickupList({ onShipped }: { onShipped: () => void }) {
  const [pickups, setPickups] = useState<Pickup[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [shipping, setShipping] = useState<Pickup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      const list = await fetchPickups();
      setPickups(list);
      setSelected((current) => current.filter((id) => list.some((item) => item.id === id)));
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les commandes prêtes."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void reload(); }, []);

  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const allSelected = pickups.length > 0 && selected.length === pickups.length;

  if (loading) return <Loading />;
  return <View style={{ flex: 1 }}>
    <FlatList
      data={pickups}
      keyExtractor={(item) => item.id}
      contentContainerStyle={[ui.content, { paddingBottom: 90 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.green} />}
      ListHeaderComponent={<View style={[ui.row, { marginTop: 8 }]}>
        <Text style={[ui.small, { flex: 1 }]}>{error || `${pickups.length} bon(s) prêt(s). Cochez ceux que vous chargez.`}</Text>
        {pickups.length ? <Pressable onPress={() => setSelected(allSelected ? [] : pickups.map((item) => item.id))} hitSlop={8}>
          <Text style={styles.link}>{allSelected ? "Tout décocher" : "Tout cocher"}</Text>
        </Pressable> : null}
      </View>}
      ListEmptyComponent={error ? null : <EmptyState title="Rien à récupérer" body="Les commandes préparées apparaîtront ici." />}
      renderItem={({ item }) => {
        const on = selected.includes(item.id);
        return <Pressable onPress={() => toggle(item.id)} style={[ui.card, styles.selectable, on && styles.selectedCard]}>
          <Check on={on} />
          <View style={{ flex: 1 }}>
            <Text style={styles.clientName} numberOfLines={1}>{item.business_name}</Text>
            <Text style={ui.small}>#{item.order_number}{item.requested_delivery_date ? ` · livraison ${formatDay(item.requested_delivery_date)}` : ""} · {item.point_label}, {item.city}</Text>
            <Text style={ui.small} numberOfLines={2}>{item.items.map((line) => `${formatQuantity(line.quantity)} ${line.unit} ${line.name}`).join(" · ")}</Text>
          </View>
        </Pressable>;
      }}
    />
    {selected.length ? <View style={styles.actionBar}>
      <Button label={`EXPÉDIER ${selected.length} BON(S)`} onPress={() => setShipping(pickups.filter((item) => selected.includes(item.id)))} style={{ flex: 1 }} />
    </View> : null}
    <ShipModal orders={shipping} onClose={() => setShipping(null)} onShipped={() => { setSelected([]); onShipped(); }} />
  </View>;
}

// Shipped orders, grouped by client: select the ones handed over together.
function ShipmentList({ onDeliver, onDelivered }: { onDeliver: (orders: Shipment[]) => void; onDelivered: () => void }) {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      setShipments(await fetchShipments());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les livraisons."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void reload(); }, []);

  const sections = useMemo(() => {
    const groups = new Map<string, Shipment[]>();
    for (const item of shipments) groups.set(item.client_id, [...(groups.get(item.client_id) ?? []), item]);
    return [...groups.values()].map((data) => ({ key: data[0].client_id, title: data[0].business_name, data }));
  }, [shipments]);

  const chosen = shipments.filter((item) => selected.includes(item.id));

  // Selection stays within one client: a hand-over is for one client.
  function toggle(item: Shipment) {
    setSelected((current) => {
      if (current.includes(item.id)) return current.filter((id) => id !== item.id);
      const sameClient = current.filter((id) => shipments.find((other) => other.id === id)?.client_id === item.client_id);
      return [...sameClient, item.id];
    });
  }

  async function deliver() {
    if (!chosen.length) return;
    const needsScan = chosen[0].scan_delivery_note || chosen[0].scan_client_qr;
    if (needsScan) {
      onDeliver(chosen);
      return;
    }
    notify("Confirmer la remise", `${chosen.length} commande(s) remise(s) à ${chosen[0].business_name} ?`, [
      { text: "Retour", style: "cancel" },
      { text: "Confirmer", onPress: () => void confirmWithoutScan() },
    ]);
  }

  async function confirmWithoutScan() {
    setBusy(true);
    try {
      const count = await deliverOrders(chosen.map((item) => item.id), [], null);
      notify("Livraison confirmée", `${count} commande(s) livrée(s) chez ${chosen[0].business_name}.`);
      setSelected([]);
      onDelivered();
    } catch (cause) {
      notify("Livraison", errorMessage(cause, "La remise n’a pas pu être confirmée."));
    } finally {
      setBusy(false);
    }
  }

  const proofLabel = (item: Shipment) => [
    item.scan_delivery_note ? "scan du bon" : null,
    item.scan_client_qr ? (item.reception_qr ? "QR de réception du client" : "QR du point") : null,
  ].filter(Boolean).join(" + ") || "sans scan";

  if (loading) return <Loading />;
  return <View style={{ flex: 1 }}>
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      contentContainerStyle={[ui.content, { paddingBottom: 90 }]}
      stickySectionHeadersEnabled={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.green} />}
      ListHeaderComponent={<Text style={[ui.small, { marginTop: 8 }]}>{error || `${shipments.length} commande(s) à livrer. Cochez celles remises ensemble au même client.`}</Text>}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune livraison" body="Les commandes expédiées apparaîtront ici." />}
      renderSectionHeader={({ section }) => <View style={styles.sectionHeader}>
        <Text style={styles.clientName} numberOfLines={1}>{section.title}</Text>
        <Text style={ui.small}>{section.data.length} commande(s) · remise : {proofLabel(section.data[0])}</Text>
      </View>}
      renderItem={({ item }) => {
        const on = selected.includes(item.id);
        return <Pressable onPress={() => toggle(item)} style={[styles.line, on && styles.selectedCard]}>
          <Check on={on} />
          <View style={{ flex: 1 }}>
            <Text style={ui.strong}>#{item.order_number} · {item.point_label}</Text>
            <Text style={ui.small}>{item.address_line}, {item.city}{item.phone ? ` · ${item.phone}` : ""}</Text>
            <Text style={ui.small}>{item.item_count} produit(s){item.requested_delivery_date ? ` · souhaitée ${formatDay(item.requested_delivery_date)}` : ""}{item.vehicle_label ? ` · ${item.vehicle_label}` : ""}{item.shipment_number ? ` · exp. #${item.shipment_number}` : ""}</Text>
          </View>
        </Pressable>;
      }}
    />
    {chosen.length ? <View style={styles.actionBar}>
      <Button label={`LIVRER ${chosen.length} COMMANDE(S)`} onPress={() => void deliver()} busy={busy} style={{ flex: 1 }} />
      <Button label="ANNULER" variant="secondary" onPress={() => setSelected([])} disabled={busy} />
    </View> : null}
  </View>;
}

const slots = [
  { key: "all", label: "Toute la journée", from: 0, to: 24 },
  { key: "morning", label: "Matin (avant 12 h)", from: 0, to: 12 },
  { key: "afternoon", label: "Après-midi (12–17 h)", from: 12, to: 17 },
  { key: "evening", label: "Soir (après 17 h)", from: 17, to: 24 },
] as const;

function DeliveryHistory() {
  const [orders, setOrders] = useState<DeliveredOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<DateFilterValue>(() => presets.last7.value());
  const [slot, setSlot] = useState<(typeof slots)[number]["key"]>("all");

  // History is loaded from 90 days back, or from the first calendar day picked if earlier.
  const since = useMemo(() => {
    const ninety = new Date();
    ninety.setDate(ninety.getDate() - 90);
    const floor = toDayKey(ninety);
    return period?.from && period.from < floor ? period.from : floor;
  }, [period]);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      setOrders(await fetchDeliveryHistory(since));
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger l’historique."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void reload(); }, [since]);

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    const selectedSlot = slots.find((item) => item.key === slot)!;
    return orders.filter((order) => {
      const hour = new Date(order.delivered_at).getHours();
      return matchesDate(order.delivered_at, period)
        && hour >= selectedSlot.from && hour < selectedSlot.to
        && `${order.business_name} ${order.point_label} ${order.city} ${order.vehicle_label ?? ""}`.toLocaleLowerCase("fr").includes(term);
    });
  }, [orders, search, period, slot]);

  const filters: Filter[] = [
    { kind: "date", title: "Livrées le", presets: [presets.today, presets.yesterday, presets.last7, presets.last30], value: period, onChange: setPeriod },
    { kind: "choice", title: "Heure", options: slots.map(({ key, label }) => ({ key, label })), value: slot, defaultValue: "all", onChange: (value) => setSlot(value as typeof slot) },
  ];

  return <View style={{ flex: 1 }}>
    <FilterBar search={search} onSearch={setSearch} placeholder="Client, ville ou véhicule" filters={filters} />
    {loading ? <Loading /> : <FlatList
    data={visible}
    keyExtractor={(item) => item.id}
    contentContainerStyle={ui.content}
    keyboardShouldPersistTaps="handled"
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.green} />}
    ListHeaderComponent={<Text style={[ui.small, { marginTop: 8 }]}>{error || `${visible.length} livraison(s)`}</Text>}
    ListEmptyComponent={error ? null : <EmptyState title="Aucune livraison" body="Aucune livraison ne correspond à ces filtres." />}
    renderItem={({ item }) => <View style={ui.card}>
      <View style={ui.row}>
        <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{item.business_name}</Text>
        <Text style={ui.small}>#{item.order_number}</Text>
      </View>
      <Text style={ui.small}>{item.point_label} — {item.address_line}, {item.city} · {item.item_count} produit(s)</Text>
      <Text style={[ui.small, { color: colors.green, fontWeight: "700" }]}>Livrée le {formatDateTime(item.delivered_at)}{item.driver_name ? ` · ${item.driver_name}` : ""}{item.vehicle_label ? ` · ${item.vehicle_label}` : ""}</Text>
    </View>}
  />}
  </View>;
}

// Hand-over: scans what the client's options require (delivery notes, client QR), then confirms.
function HandoverModal({ preselected, onClose, onDelivered }: { preselected: Shipment[] | null; onClose: () => void; onDelivered: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [notes, setNotes] = useState<ScannedDeliveryNote[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lastScan = useRef({ data: "", at: 0 });
  const visible = preselected !== null;
  const chosen = preselected ?? [];

  useEffect(() => {
    if (!visible) return;
    setNotes([]);
    setMessage("");
    setError("");
    lastScan.current = { data: "", at: 0 };
  }, [visible]);

  const first = chosen[0] ?? notes[0];
  const rules = first ? { notes: first.scan_delivery_note, qr: first.scan_client_qr, reception: first.reception_qr } : null;
  const orderIds = [...new Set([...chosen.map((item) => item.id), ...notes.map((note) => note.id)])];
  const missing = rules?.notes ? chosen.filter((item) => !notes.some((note) => note.id === item.id)) : [];
  const readyForClient = orderIds.length > 0 && missing.length === 0;
  const businessName = first?.business_name ?? "Scanner";

  async function deliver(clientQr: { kind: "point" | "client"; token: string } | null) {
    setBusy(true);
    try {
      const count = await deliverOrders(orderIds, notes.map((note) => note.delivery_token), clientQr);
      notify("Livraison confirmée", `${count} commande(s) livrée(s) chez ${businessName}.`);
      onDelivered();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "La remise n’a pas pu être confirmée."));
    } finally {
      setBusy(false);
    }
  }

  async function onScan(data: string) {
    // The camera reports the same code many times per second.
    const now = Date.now();
    if (busy || (lastScan.current.data === data && now - lastScan.current.at < 3000)) return;
    lastScan.current = { data, at: now };

    const scanned = parseQr(data);
    if (!scanned) {
      setError("Ce QR code n’est pas un code AgriFresh.");
      return;
    }
    setError("");
    if (scanned.kind === "bl") {
      if (notes.some((note) => note.delivery_token === scanned.token)) {
        setMessage("Ce bon est déjà scanné.");
        return;
      }
      setBusy(true);
      try {
        const note = await lookupDeliveryNote(scanned.token);
        if (first && first.client_id !== note.client_id) {
          setError(`Ce bon concerne ${note.business_name} : livrez d’abord ${businessName}.`);
          return;
        }
        setNotes((current) => [...current, note]);
        setMessage(`Bon #${note.order_number} ajouté.`);
      } catch (cause) {
        setError(errorMessage(cause, "Bon de livraison non reconnu."));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!readyForClient) {
      setError(orderIds.length ? `Scannez d’abord le bon de ${missing.map((item) => `#${item.order_number}`).join(", ")}.` : "Scannez d’abord le QR code du bon de livraison.");
      return;
    }
    if (!rules?.qr) {
      setMessage("Le QR client n’est pas demandé pour ce client : touchez « Confirmer la remise ».");
      return;
    }
    await deliver({ kind: scanned.kind, token: scanned.token });
  }

  const instruction = !orderIds.length ? "① Scannez le QR code du bon de livraison."
    : missing.length ? `① Scannez le bon de ${missing.map((item) => `#${item.order_number}`).join(", ")}.`
    : rules?.qr ? (rules.reception ? "② Scannez le QR de réception affiché dans l’application du client." : "② Scannez le QR code collé au point de livraison.")
    : "Tout est prêt : confirmez la remise.";

  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="REMISE AU CLIENT" title={businessName} right={<CloseButton onPress={onClose} />} />
      {!permission ? <Loading /> : !permission.granted ? <EmptyState
        title="Accès à la caméra"
        body="La caméra sert uniquement à lire les QR codes des bons de livraison et des clients."
        action={<Button label="AUTORISER LA CAMÉRA" onPress={() => void requestPermission()} />}
      /> : <View style={{ flex: 1 }}>
        <View style={styles.cameraFrame}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => { void onScan(data); }}
          />
          <View pointerEvents="none" style={styles.viewfinder} />
        </View>
        <ScrollView contentContainerStyle={ui.content}>
          <Text style={[ui.strong, { marginTop: 10, textAlign: "center" }]}>{busy ? "Vérification…" : instruction}</Text>
          {message && !error ? <Text style={[ui.success, { textAlign: "center", marginTop: 4 }]}>{message}</Text> : null}
          {error ? <Text style={[ui.error, { textAlign: "center", marginTop: 4 }]}>{error}</Text> : null}
          {readyForClient && !rules?.qr ? <Button label="CONFIRMER LA REMISE" onPress={() => void deliver(null)} busy={busy} style={{ marginTop: 10 }} /> : null}
          {[...chosen.map((item) => ({ id: item.id, number: item.order_number, label: item.point_label })), ...notes.filter((note) => !chosen.some((item) => item.id === note.id)).map((note) => ({ id: note.id, number: note.order_number, label: note.point_label }))].map((line) => {
            const scanned = notes.some((note) => note.id === line.id);
            return <View key={line.id} style={[ui.card, ui.row]}>
              <Ionicons name={scanned ? "checkmark-circle" : "ellipse-outline"} size={18} color={scanned ? colors.green : colors.muted} />
              <Text style={[ui.strong, { flex: 1 }]}>Bon #{line.number}</Text>
              <Text style={ui.small}>{line.label}{rules?.notes ? (scanned ? " · scanné" : " · à scanner") : ""}</Text>
            </View>;
          })}
          {notes.length ? <Button label="RECOMMENCER LES SCANS" variant="secondary" onPress={() => { setNotes([]); setMessage(""); setError(""); }} style={{ marginTop: 10 }} /> : null}
        </ScrollView>
      </View>}
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  clientName: { color: colors.text, fontSize: 15, fontWeight: "800" },
  link: { color: colors.green, fontSize: 12, fontWeight: "800" },
  selectable: { flexDirection: "row", alignItems: "center", gap: 10 },
  selectedCard: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
  sectionHeader: { marginTop: 14, marginBottom: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 8, marginTop: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  actionBar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.white },
  cameraFrame: { height: 260, marginHorizontal: 14, marginTop: 10, borderRadius: 16, overflow: "hidden", backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  viewfinder: { width: 180, height: 180, borderWidth: 3, borderColor: colors.white, borderRadius: 18, opacity: 0.85 },
});
