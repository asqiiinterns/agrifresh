import { useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
import { SafeAreaView } from "react-native-safe-area-context";
import { scheduleOrder, type StaffOrder } from "../data/staff";
import { CloseButton, EmptyState, ScreenHeader, StatusBadge, formatDay } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// The production queue in execution order: move an order up or down, or insert the
// selected order before another one. Every move is saved at once.
export function PlanningScreen({ visible, focusId, queue, onClose, onChanged }: {
  visible: boolean;
  focusId: string | null;
  queue: StaffOrder[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const selected = selectedId ?? focusId;

  async function place(orderId: string, beforeId: string | null) {
    setBusyId(orderId);
    setError("");
    try {
      await scheduleOrder(orderId, beforeId);
      await onChanged();
    } catch (cause) {
      setError(errorMessage(cause, "La file n’a pas pu être modifiée."));
    } finally {
      setBusyId(null);
    }
  }

  // Up = before the previous order; down = before the order after the next one (or at the end).
  const moveUp = (index: number) => {
    const order = queue.at(index), previous = queue.at(index - 1);
    if (order && previous && index > 0) void place(order.id, previous.id);
  };
  const moveDown = (index: number) => {
    const order = queue.at(index);
    if (!order || index >= queue.length - 1) return;
    void place(order.id, queue.at(index + 2)?.id ?? null);
  };

  const name = (order: StaffOrder) => order.clients?.business_name ?? order.address_snapshot?.business_name ?? "Client";
  const selectedOrder = queue.find((order) => order.id === selected) ?? null;

  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader
        eyebrow={`FILE DE PRODUCTION · ${queue.length} COMMANDE(S)`}
        title="Planifier"
        subtitle={selectedOrder ? `#${selectedOrder.order_number} sélectionnée : touchez « Insérer avant » sur une autre commande, ou utilisez ▲ ▼.` : "Touchez une commande pour la sélectionner, puis déplacez-la."}
        right={<CloseButton onPress={() => { setSelectedId(null); onClose(); }} />}
      />
      {error ? <Text style={[ui.error, { paddingHorizontal: 18, marginTop: 8 }]}>{error}</Text> : null}
      <FlatList
        data={queue}
        keyExtractor={(order) => order.id}
        contentContainerStyle={ui.content}
        ListEmptyComponent={<EmptyState title="File vide" body="Aucune commande acceptée à planifier." />}
        renderItem={({ item, index }) => {
          const isSelected = item.id === selected;
          const busy = busyId !== null;
          return <Pressable onPress={() => setSelectedId(isSelected ? null : item.id)} style={[styles.row, isSelected && styles.rowSelected]}>
            <Text style={[styles.position, isSelected && styles.positionSelected]}>{index + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.clientName} numberOfLines={1}>{name(item)}</Text>
              <Text style={ui.small}>Commande #{item.order_number} · {item.requested_delivery_date ? `Livraison ${formatDay(item.requested_delivery_date)}` : "Dès que possible"} · {item.order_items.length} produit(s)</Text>
              <View style={{ marginTop: 4 }}><StatusBadge status={item.status} /></View>
              {selectedOrder && !isSelected ? <Pressable onPress={() => void place(selectedOrder.id, item.id)} disabled={busy} style={styles.insert}>
                <Text style={styles.insertText}>↳ Insérer #{selectedOrder.order_number} avant celle-ci</Text>
              </Pressable> : null}
            </View>
            <View style={styles.arrows}>
              <Pressable onPress={() => moveUp(index)} disabled={busy || index === 0} style={[styles.arrow, (busy || index === 0) && ui.disabled]} accessibilityLabel={`Monter la commande ${item.order_number}`}><Text style={styles.arrowText}>▲</Text></Pressable>
              <Pressable onPress={() => moveDown(index)} disabled={busy || index === queue.length - 1} style={[styles.arrow, (busy || index === queue.length - 1) && ui.disabled]} accessibilityLabel={`Descendre la commande ${item.order_number}`}><Text style={styles.arrowText}>▼</Text></Pressable>
            </View>
          </Pressable>;
        }}
      />
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  clientName: { color: colors.text, fontSize: 16, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, marginTop: 8, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  rowSelected: { borderColor: colors.green, borderWidth: 2, backgroundColor: "#f3f8f1" },
  position: { minWidth: 28, height: 28, borderRadius: 14, backgroundColor: colors.cream, color: colors.green, textAlign: "center", lineHeight: 28, fontWeight: "800" },
  positionSelected: { backgroundColor: colors.green, color: colors.white },
  insert: { marginTop: 8, alignSelf: "flex-start", borderWidth: 1, borderColor: colors.green, borderStyle: "dashed", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  insertText: { color: colors.green, fontSize: 11, fontWeight: "800" },
  arrows: { gap: 6 },
  arrow: { width: 40, height: 36, borderRadius: 8, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center", backgroundColor: colors.white },
  arrowText: { color: colors.green, fontSize: 14 },
});
