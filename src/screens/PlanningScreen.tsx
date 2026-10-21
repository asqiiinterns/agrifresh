import { useEffect, useMemo, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { FlatList, Modal, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import { executionQueue, fetchAllOrders, scheduleOrder, setOrderFlags, type StaffOrder } from "../data/staff";
import { notify } from "../ui/notify";
import { CloseButton, EmptyState, Loading, ScreenHeader, StatusBadge, formatDay } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { useModules } from "../data/modules";

// The production queue in execution order: move an order up or down, or insert the
// selected order before another one. Every move is saved at once.
function PlanningBoard({ queue, focusId, onChanged, header, refreshControl }: {
  queue: StaffOrder[];
  focusId: string | null;
  onChanged: () => Promise<void>;
  header: (subtitle: string) => ReactNode;
  refreshControl?: ReactElement<ComponentProps<typeof RefreshControl>>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tagsOn = useModules()("order_tags");
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

  async function toggleReschedule(order: StaffOrder) {
    try {
      await setOrderFlags(order.id, { reschedule: !order.needs_reschedule });
      await onChanged();
    } catch (cause) {
      notify("Planning", errorMessage(cause, "La pastille n’a pas pu être enregistrée."));
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
  const subtitle = selectedOrder
    ? `#${selectedOrder.order_number} sélectionnée : « Insérer avant » sur une autre commande, ou ▲ ▼.`
    : "Touchez une commande pour la sélectionner, puis déplacez-la.";

  return <>
    {header(subtitle)}
    {error ? <Text style={[ui.error, { paddingHorizontal: 14, marginTop: 8 }]}>{error}</Text> : null}
    <FlatList
      data={queue}
      keyExtractor={(order) => order.id}
      contentContainerStyle={ui.content}
      refreshControl={refreshControl}
      ListEmptyComponent={<EmptyState title="File vide" body="Aucune commande acceptée à planifier." />}
      renderItem={({ item, index }) => {
        const isSelected = item.id === selected;
        const busy = busyId !== null;
        return <Pressable onPress={() => setSelectedId(isSelected ? null : item.id)} style={[styles.row, isSelected && styles.rowSelected]}>
          <Text style={[styles.position, isSelected && styles.positionSelected]}>{index + 1}</Text>
          <View style={{ flex: 1 }}>
            <View style={[ui.row, { justifyContent: "flex-start", gap: 6 }]}>
              <Text style={[styles.clientName, { flexShrink: 1 }]} numberOfLines={1}>{name(item)}</Text>
              <StatusBadge status={item.status} />
              {item.needs_reschedule ? <Text style={styles.reschedule}>↻ À reprogrammer</Text> : null}
            </View>
            <Text style={ui.small}>#{item.order_number} · {item.requested_delivery_date ? `Livraison ${formatDay(item.requested_delivery_date)}` : "Dès que possible"} · {item.order_items.length} produit(s)</Text>
            {tagsOn ? <Pressable onPress={() => void toggleReschedule(item)} hitSlop={6} style={styles.flag}>
              <Text style={[styles.flagBox, item.needs_reschedule && styles.flagBoxOn]}>{item.needs_reschedule ? "✓" : ""}</Text>
              <Text style={styles.flagText}>À reprogrammer</Text>
            </Pressable> : null}
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
  </>;
}

// Full-screen planning opened from an order (e.g. right after accepting it).
export function PlanningScreen({ visible, focusId, queue, onClose, onChanged }: {
  visible: boolean;
  focusId: string | null;
  queue: StaffOrder[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <PlanningBoard
        key={`${visible}-${focusId}`}
        queue={queue}
        focusId={focusId}
        onChanged={onChanged}
        header={(subtitle) => <ScreenHeader eyebrow={`FILE DE PRODUCTION · ${queue.length} COMMANDE(S)`} title="Planifier" subtitle={subtitle} right={<CloseButton onPress={onClose} />} />}
      />
    </SafeAreaView>
  </Modal>;
}

// The "Planning" tab: the same board, always one tap away.
export function PlanningTab() {
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  async function reload(refresh = false, fresh = refresh) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      setOrders(await fetchAllOrders(fresh));
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger la file de production."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const realtime = supabase;
    void reload();
    if (!realtime) return;
    const channel = realtime.channel("planning-tab")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => { void reload(false, true); })
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, []);

  const queue = useMemo(() => executionQueue(orders), [orders]);
  if (loading) return <View style={ui.screen}><ScreenHeader eyebrow="FILE DE PRODUCTION" title="Planning" /><Loading /></View>;
  return <View style={ui.screen}>
    <PlanningBoard
      queue={queue}
      focusId={null}
      onChanged={() => reload()}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      header={(subtitle) => <>
        <ScreenHeader eyebrow={`FILE DE PRODUCTION · ${queue.length} COMMANDE(S)`} title="Planning" subtitle={subtitle} />
        {error ? <Text style={[ui.error, { paddingHorizontal: 14, marginTop: 8 }]}>{error}</Text> : null}
      </>}
    />
  </View>;
}

const styles = StyleSheet.create({
  clientName: { color: colors.text, fontSize: 15, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 8, marginTop: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  rowSelected: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.primarySoft },
  position: { minWidth: 26, height: 26, borderRadius: 13, backgroundColor: colors.cream, color: colors.primary, textAlign: "center", lineHeight: 26, fontWeight: "800" },
  positionSelected: { backgroundColor: colors.primary, color: colors.white },
  reschedule: { color: colors.danger, fontSize: 10, fontWeight: "800" },
  flag: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, alignSelf: "flex-start" },
  flagBox: { width: 18, height: 18, borderRadius: 4, borderWidth: 2, borderColor: colors.line, textAlign: "center", lineHeight: 15, color: colors.white, fontSize: 11, fontWeight: "800" },
  flagBoxOn: { backgroundColor: colors.danger, borderColor: colors.danger },
  flagText: { color: colors.muted, fontSize: 11, fontWeight: "700" },
  insert: { marginTop: 6, alignSelf: "flex-start", borderWidth: 1, borderColor: colors.primary, borderStyle: "dashed", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  insertText: { color: colors.primary, fontSize: 11, fontWeight: "800" },
  arrows: { gap: 4 },
  arrow: { width: 38, height: 30, borderRadius: 8, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center", backgroundColor: colors.white },
  arrowText: { color: colors.primary, fontSize: 13 },
});
