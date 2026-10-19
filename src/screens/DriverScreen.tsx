import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { confirmHandover, fetchDeliveryHistory, fetchShipments, lookupDeliveryNote, type DeliveredOrder, type ScannedDeliveryNote, type Shipment } from "../data/delivery";
import { Button, Chip, CloseButton, EmptyState, Loading, ScreenHeader, formatDateTime, formatDay, formatQuantity, toDayKey } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { parseQr } from "../ui/Qr";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";
import { colors, ui } from "../ui/theme";

type Tab = "todo" | "history";

export function DriverScreen() {
  const [tab, setTab] = useState<Tab>("todo");
  const [scannerVisible, setScannerVisible] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="ESPACE LIVREUR" title="Livraisons" />
    <View style={styles.tabs}>
      <Chip label="À livrer" selected={tab === "todo"} onPress={() => setTab("todo")} />
      <Chip label="Historique" selected={tab === "history"} onPress={() => setTab("history")} />
    </View>
    {tab === "todo" ? <>
      <View style={{ paddingHorizontal: 18 }}>
        <Button label="SCANNER UNE LIVRAISON" onPress={() => setScannerVisible(true)} style={{ minHeight: 56 }} />
      </View>
      <ShipmentList key={`todo-${refreshKey}`} />
    </> : <DeliveryHistory key={`history-${refreshKey}`} />}
    <HandoverModal visible={scannerVisible} onClose={() => setScannerVisible(false)} onDelivered={() => setRefreshKey((key) => key + 1)} />
  </View>;
}

function ShipmentList() {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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

  if (loading) return <Loading />;
  return <FlatList
    data={shipments}
    keyExtractor={(item) => item.id}
    contentContainerStyle={ui.content}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.green} />}
    ListHeaderComponent={<Text style={[ui.small, { marginTop: 12 }]}>{error || `${shipments.length} commande(s) expédiée(s) à livrer`}</Text>}
    ListEmptyComponent={error ? null : <EmptyState title="Aucune livraison" body="Les commandes expédiées par AgriFresh apparaîtront ici." />}
    renderItem={({ item }) => <View style={ui.card}>
      <View style={ui.row}>
        <Text style={[ui.strong, { flex: 1 }]}>{item.business_name}</Text>
        <Text style={ui.small}>#{item.order_number}</Text>
      </View>
      <Text style={ui.body}>{item.point_label} — {item.address_line}, {item.city}</Text>
      <Text style={ui.small}>
        {item.item_count} produit(s){item.phone ? ` · ${item.phone}` : ""}
        {item.requested_delivery_date ? ` · souhaitée ${formatDay(item.requested_delivery_date)}` : ""}
      </Text>
    </View>}
  />;
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
        && `${order.business_name} ${order.point_label} ${order.city}`.toLocaleLowerCase("fr").includes(term);
    });
  }, [orders, search, period, slot]);

  const filters: Filter[] = [
    { kind: "date", title: "Livrées le", presets: [presets.today, presets.yesterday, presets.last7, presets.last30], value: period, onChange: setPeriod },
    { kind: "choice", title: "Heure", options: slots.map(({ key, label }) => ({ key, label })), value: slot, defaultValue: "all", onChange: (value) => setSlot(value as typeof slot) },
  ];

  return <View style={{ flex: 1 }}>
    <FilterBar search={search} onSearch={setSearch} placeholder="Client ou ville" filters={filters} />
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
        <Text style={[ui.strong, { flex: 1 }]}>{item.business_name}</Text>
        <Text style={ui.small}>#{item.order_number}</Text>
      </View>
      <Text style={ui.body}>{item.point_label} — {item.address_line}, {item.city}</Text>
      <Text style={[ui.small, { color: colors.green, fontWeight: "700" }]}>Livrée le {formatDateTime(item.delivered_at)}{item.driver_name ? ` · ${item.driver_name}` : ""}</Text>
      <Text style={ui.small}>{item.item_count} produit(s)</Text>
    </View>}
  />}
  </View>;
}

function HandoverModal({ visible, onClose, onDelivered }: { visible: boolean; onClose: () => void; onDelivered: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [notes, setNotes] = useState<ScannedDeliveryNote[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lastScan = useRef({ data: "", at: 0 });

  useEffect(() => {
    if (!visible) return;
    setNotes([]);
    setMessage("");
    setError("");
    lastScan.current = { data: "", at: 0 };
  }, [visible]);

  const needsClientApp = notes[0]?.reception_qr ?? false;

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
    setBusy(true);
    try {
      if (scanned.kind === "bl") {
        if (notes.some((note) => note.delivery_token === scanned.token)) {
          setMessage("Ce bon est déjà scanné.");
          return;
        }
        const note = await lookupDeliveryNote(scanned.token);
        if (notes.length && notes[0].client_id !== note.client_id) {
          setError(`Ce bon concerne ${note.business_name} : livrez d’abord ${notes[0].business_name}.`);
          return;
        }
        setNotes((current) => [...current, note]);
        setMessage(`Bon #${note.order_number} ajouté. Scannez les autres bons, puis le QR du client.`);
        return;
      }
      if (notes.length === 0) {
        setError("Scannez d’abord le QR code du bon de livraison.");
        return;
      }
      const count = await confirmHandover(notes.map((note) => note.delivery_token), { kind: scanned.kind, token: scanned.token });
      notify("Livraison confirmée", `${count} commande(s) livrée(s) chez ${notes[0].business_name}.`);
      onDelivered();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "Scan non reconnu."));
    } finally {
      setBusy(false);
    }
  }

  const instruction = notes.length === 0
    ? "① Scannez le QR code du bon de livraison."
    : needsClientApp
      ? "② Scannez le QR de réception affiché dans l’application du client."
      : "② Scannez le QR code collé au point de livraison.";

  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="REMISE AU CLIENT" title={notes[0]?.business_name ?? "Scanner"} right={<CloseButton onPress={onClose} />} />
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
          <Text style={[ui.strong, { marginTop: 12, textAlign: "center" }]}>{busy ? "Vérification…" : instruction}</Text>
          {message && !error ? <Text style={[ui.success, { textAlign: "center", marginTop: 4 }]}>{message}</Text> : null}
          {error ? <Text style={[ui.error, { textAlign: "center", marginTop: 4 }]}>{error}</Text> : null}
          {notes.map((note) => <View key={note.id} style={ui.card}>
            <View style={ui.row}>
              <Text style={[ui.strong, { flex: 1 }]}>✓ Bon #{note.order_number}</Text>
              <Text style={ui.small}>{note.point_label}</Text>
            </View>
            {note.items.map((line, index) => <Text key={`${note.id}-${index}`} style={ui.body}>{formatQuantity(line.quantity)} {line.unit} · {line.name}</Text>)}
          </View>)}
          {notes.length ? <Button label="RECOMMENCER" variant="secondary" onPress={() => { setNotes([]); setMessage(""); setError(""); }} style={{ marginTop: 12 }} /> : null}
        </ScrollView>
      </View>}
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: 18, paddingVertical: 10 },
  filterRow: { gap: 7, paddingVertical: 8 },
  cameraFrame: { height: 300, marginHorizontal: 18, marginTop: 12, borderRadius: 16, overflow: "hidden", backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  viewfinder: { width: 200, height: 200, borderWidth: 3, borderColor: colors.white, borderRadius: 18, opacity: 0.85 },
});
