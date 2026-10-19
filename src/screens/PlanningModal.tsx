import { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { scheduleOrder, updateOrderStatus, type StaffOrder } from "../data/staff";
import { Button, CloseButton, EmptyState, ScreenHeader, StatusBadge, formatDay } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Accepting an order means placing it in the production queue: staff pick the order
// it must be executed before, or the end of the queue.
export function PlanningModal({ order, queue, mode, onClose, onDone }: {
  order: StaffOrder | null;
  queue: StaffOrder[];
  mode: "accept" | "move";
  onClose: () => void;
  onDone: () => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const others = queue.filter((item) => item.id !== order?.id);

  async function place(beforeId: string | null) {
    if (!order) return;
    setBusyKey(beforeId ?? "end");
    setError("");
    try {
      if (mode === "accept") await updateOrderStatus(order.id, "confirmed");
      if (beforeId || mode === "move") await scheduleOrder(order.id, beforeId);
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, "La planification a échoué."));
    } finally {
      setBusyKey(null);
    }
  }

  const name = (item: StaffOrder) => item.clients?.business_name ?? item.address_snapshot?.business_name ?? "Client";

  return <Modal visible={order !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader
        eyebrow={mode === "accept" ? "ACCEPTER ET PLANIFIER" : "DÉPLACER DANS LA FILE"}
        title={order ? `#${order.order_number} · ${name(order)}` : ""}
        subtitle="Choisissez avant quelle commande l’exécuter, ou placez-la à la fin de la file de production."
        right={<CloseButton onPress={onClose} />}
      />
      <ScrollView contentContainerStyle={ui.content}>
        {order?.requested_delivery_date ? <Text style={[ui.body, { marginTop: 12 }]}>Livraison souhaitée : <Text style={{ fontWeight: "800" }}>{formatDay(order.requested_delivery_date, { weekday: "long", day: "numeric", month: "long" })}</Text></Text> : null}
        {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
        <Text style={[ui.strong, { marginTop: 14 }]}>File de production ({others.length})</Text>
        {others.length === 0 ? <EmptyState title="File vide" body="Cette commande sera la prochaine à préparer." /> : others.map((item, index) => <View key={item.id}>
          <Button label={`▲ PLACER ICI (avant #${item.order_number})`} variant="secondary" onPress={() => void place(item.id)} busy={busyKey === item.id} disabled={busyKey !== null} style={styles.slot} />
          <View style={styles.queueItem}>
            <Text style={styles.position}>{index + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={ui.strong}>#{item.order_number} · {name(item)}</Text>
              <Text style={ui.small}>{item.requested_delivery_date ? `Livraison ${formatDay(item.requested_delivery_date)}` : "Dès que possible"} · {item.order_items.length} produit(s)</Text>
            </View>
            <StatusBadge status={item.status} />
          </View>
        </View>)}
        <Button label={mode === "accept" ? "ACCEPTER — À LA FIN DE LA FILE" : "À LA FIN DE LA FILE"} onPress={() => void place(null)} busy={busyKey === "end"} disabled={busyKey !== null} style={{ marginTop: 14 }} />
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  slot: { marginTop: 10, minHeight: 36, paddingVertical: 6, borderStyle: "dashed" },
  queueItem: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, marginTop: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  position: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.cream, textAlign: "center", lineHeight: 26, color: colors.green, fontWeight: "800" },
});
