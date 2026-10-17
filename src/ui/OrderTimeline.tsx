import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { timeline, type Order } from "../data/orders";
import { formatDateTime, statusLabel } from "./components";
import { colors, ui } from "./theme";

// Who did what and when: keeps the trace when an order is declined, reopened and reconfirmed.
export function OrderTimeline({ order, viewer }: { order: Order; viewer: "client" | "staff" }) {
  const [open, setOpen] = useState(false);
  const events = timeline(order);
  if (events.length === 0) return null;
  return <View style={{ marginTop: 8 }}>
    <Pressable onPress={() => setOpen((value) => !value)} hitSlop={8}>
      <Text style={[ui.small, { color: colors.green, fontWeight: "800" }]}>{open ? "▾" : "▸"} HISTORIQUE ({events.length})</Text>
    </Pressable>
    {open ? <View style={styles.list}>
      {events.map((event, index) => {
        const actor = event.byClient ? (viewer === "client" ? "Vous" : "Client") : (viewer === "client" ? "AgriFresh" : "Personnel");
        return <View key={`${event.created_at}-${index}`} style={styles.item}>
          <View style={[styles.dot, event.byClient && styles.dotClient]} />
          <View style={{ flex: 1 }}>
            <Text style={ui.body}><Text style={{ fontWeight: "800" }}>{statusLabel(event.status)}</Text> · {actor}</Text>
            <Text style={ui.small}>{formatDateTime(event.created_at)}</Text>
            {event.note ? <Text style={[ui.small, { color: colors.text }]}>{event.note}</Text> : null}
          </View>
        </View>;
      })}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  list: { marginTop: 6, borderLeftWidth: 2, borderLeftColor: colors.line, marginLeft: 4, paddingLeft: 12, gap: 8 },
  item: { flexDirection: "row", gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.green, marginLeft: -18, marginTop: 4 },
  dotClient: { backgroundColor: colors.orange },
});
