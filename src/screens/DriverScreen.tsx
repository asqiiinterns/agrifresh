import { useEffect, useRef, useState } from "react";
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { formatClientNumber } from "../data/account";
import { parseDeliveryQr } from "../data/clients";
import { confirmDelivery, fetchShipments, lookupDeliveryPoint, type ScannedPoint, type Shipment } from "../data/delivery";
import { Button, CloseButton, EmptyState, Loading, ScreenHeader, formatDay, formatPrice, formatQuantity } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

export function DriverScreen() {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [scannerVisible, setScannerVisible] = useState(false);

  async function reload(mode: "initial" | "refresh" | "silent") {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
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

  useEffect(() => { void reload("initial"); }, []);

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`${shipments.length} COMMANDE(S) EXPÉDIÉE(S)`} title="Livraisons" />
    <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
      <Button label="SCANNER LE QR CODE DU CLIENT" onPress={() => setScannerVisible(true)} style={{ minHeight: 56 }} />
    </View>
    {loading ? <Loading /> : <FlatList
      data={shipments}
      keyExtractor={(item) => item.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune livraison" body="Les commandes expédiées par AgriFresh apparaîtront ici." />}
      renderItem={({ item }) => <View style={ui.card}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]}>{item.business_name}</Text>
          <Text style={ui.small}>#{item.order_number}</Text>
        </View>
        <Text style={ui.body}>{item.point_label} — {item.address_line}, {item.city}</Text>
        <Text style={ui.small}>
          {item.item_count} produit(s) · {formatPrice(item.total)}{item.phone ? ` · ${item.phone}` : ""}
          {item.requested_delivery_date ? ` · ${formatDay(item.requested_delivery_date)}` : ""}
        </Text>
      </View>}
    />}

    <ScannerModal visible={scannerVisible} onClose={() => setScannerVisible(false)} onDelivered={() => void reload("silent")} />
  </View>;
}

function ScannerModal({ visible, onClose, onDelivered }: { visible: boolean; onClose: () => void; onDelivered: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [token, setToken] = useState<string | null>(null);
  const [scanned, setScanned] = useState<ScannedPoint | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const handling = useRef(false);

  useEffect(() => {
    if (!visible) return;
    setToken(null);
    setScanned(null);
    setSelected([]);
    setError("");
    handling.current = false;
  }, [visible]);

  async function onScan(data: string) {
    if (handling.current) return;
    const qrToken = parseDeliveryQr(data);
    if (!qrToken) {
      setError("Ce QR code n’est pas un code AgriFresh.");
      return;
    }
    handling.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await lookupDeliveryPoint(qrToken);
      setToken(qrToken);
      setScanned(result);
      // A single shipment is preselected; with several, the driver picks what is handed over.
      setSelected(result.orders.length === 1 ? [result.orders[0].id] : []);
    } catch (cause) {
      setError(errorMessage(cause, "QR code non reconnu."));
      handling.current = false;
    } finally {
      setBusy(false);
    }
  }

  function rescan() {
    setToken(null);
    setScanned(null);
    setSelected([]);
    setError("");
    handling.current = false;
  }

  async function confirm() {
    if (!token || selected.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const count = await confirmDelivery(token, selected);
      notify("Livraison enregistrée", `${count} commande(s) marquée(s) comme livrée(s).`);
      onDelivered();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "La livraison n’a pas pu être enregistrée."));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="LIVRAISON" title={scanned ? scanned.point.business_name : "Scanner le QR code"} right={<CloseButton onPress={onClose} />} />
      {!scanned ? <View style={{ flex: 1, padding: 18 }}>
        {!permission ? <Loading /> : !permission.granted ? <EmptyState
          title="Accès à la caméra"
          body="La caméra sert uniquement à lire le QR code collé chez le client."
          action={<Button label="AUTORISER LA CAMÉRA" onPress={() => void requestPermission()} />}
        /> : <>
          <View style={styles.cameraFrame}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={busy ? undefined : ({ data }) => { void onScan(data); }}
            />
            <View pointerEvents="none" style={styles.viewfinder} />
          </View>
          <Text style={[ui.subtitle, { textAlign: "center", marginTop: 14 }]}>{busy ? "Vérification du code…" : "Visez le QR code collé au point de livraison."}</Text>
          {error ? <Text style={[ui.error, { textAlign: "center", marginTop: 8 }]}>{error}</Text> : null}
        </>}
      </View> : <ScrollView contentContainerStyle={ui.content}>
        <View style={ui.card}>
          <Text style={ui.strong}>{scanned.point.label}</Text>
          <Text style={ui.body}>{scanned.point.address_line}, {scanned.point.city}</Text>
          <Text style={ui.small}>{formatClientNumber(scanned.point.client_number)}</Text>
        </View>

        {scanned.orders.length === 0 ? <EmptyState title="Aucune commande expédiée" body="Aucune commande en cours de livraison pour ce point." /> : <>
          <Text style={[ui.subtitle, { marginTop: 14 }]}>{scanned.orders.length > 1 ? "Cochez les commandes remises au client :" : "Commande à remettre :"}</Text>
          {scanned.orders.map((order) => {
            const checked = selected.includes(order.id);
            return <Pressable key={order.id} onPress={() => toggle(order.id)} style={[ui.card, checked && styles.selectedCard]}>
              <View style={ui.row}>
                <View style={[styles.checkbox, checked && styles.checkboxChecked]}>{checked ? <Text style={styles.checkmark}>✓</Text> : null}</View>
                <Text style={[ui.strong, { flex: 1 }]}>Commande #{order.order_number}</Text>
                <Text style={ui.amount}>{formatPrice(order.total)}</Text>
              </View>
              {order.items.map((line, index) => <Text key={`${order.id}-${index}`} style={[ui.body, { marginLeft: 34 }]}>{formatQuantity(line.quantity)} {line.unit} · {line.name}</Text>)}
            </Pressable>;
          })}
        </>}

        {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
        {scanned.orders.length ? <Button label={`CONFIRMER LA LIVRAISON (${selected.length})`} onPress={() => void confirm()} busy={busy} disabled={selected.length === 0} style={{ marginTop: 16 }} /> : null}
        <Button label="SCANNER UN AUTRE CODE" variant="secondary" onPress={rescan} disabled={busy} style={{ marginTop: 10 }} />
      </ScrollView>}
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  cameraFrame: { flex: 1, maxHeight: 460, borderRadius: 16, overflow: "hidden", backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  viewfinder: { width: 220, height: 220, borderWidth: 3, borderColor: colors.white, borderRadius: 18, opacity: 0.85 },
  selectedCard: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: colors.green, borderColor: colors.green },
  checkmark: { color: colors.white, fontWeight: "800" },
});
