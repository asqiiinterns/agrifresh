import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { timeline, type Order } from "../data/orders";
import { formatDay, statusLabel, statusStyles, toDayKey } from "./components";
import { appLocale } from "./i18n";
import { colors, ui } from "./theme";

const time = (value: string) => new Date(value).toLocaleTimeString(appLocale(), { hour: "2-digit", minute: "2-digit" });

// "2 h 15", "35 min", "3 j 4 h": time spent between two steps.
export function elapsed(from: string, to: string) {
  const minutes = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${minutes % 60 ? ` ${String(minutes % 60).padStart(2, "0")}` : ""}`;
  return `${Math.floor(hours / 24)} j${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

// Who did what and when, step by step: one line per change, grouped by day, with the time spent
// since the previous step. Keeps the trace when an order is declined, reopened and reconfirmed.
export function OrderTimeline({ order, viewer }: { order: Order; viewer: "client" | "staff" }) {
  const [open, setOpen] = useState(false);
  const events = timeline(order);
  if (events.length === 0) return null;
  const first = events[0];
  const last = events[events.length - 1];

  return <View style={styles.box}>
    <Pressable onPress={() => setOpen((value) => !value)} hitSlop={8} style={ui.row}>
      <Text style={[ui.small, { color: colors.primary, fontWeight: "800", flex: 1 }]}>{open ? "▾" : "▸"} HISTORIQUE ({events.length})</Text>
      {events.length > 1 ? <Text style={ui.small}>Durée totale {elapsed(first.created_at, last.created_at)}</Text> : null}
    </Pressable>
    {open ? <View style={{ marginTop: 8 }}>
      {events.map((event, index) => {
        const style = statusStyles[event.status];
        const color = style?.color ?? colors.primary;
        const actor = event.byClient ? (viewer === "client" ? "Vous" : event.changed_by_name ?? "Client") : (viewer === "client" ? "Fournisseur" : event.changed_by_name ?? "Personnel");
        const previous = events[index - 1];
        const newDay = !previous || toDayKey(new Date(previous.created_at)) !== toDayKey(new Date(event.created_at));
        const isLast = index === events.length - 1;
        return <View key={`${event.created_at}-${index}`}>
          {newDay ? <Text style={styles.day}>{formatDay(event.created_at, { weekday: "long", day: "numeric", month: "long" })}</Text> : null}
          <View style={styles.row}>
            <Text style={styles.time}>{time(event.created_at)}</Text>
            <View style={styles.rail}>
              <View style={[styles.dot, { backgroundColor: color }, isLast && styles.dotCurrent]} />
              {!isLast ? <View style={styles.line} /> : null}
            </View>
            <View style={styles.body}>
              <View style={[ui.row, { gap: 6 }]}>
                <View style={[styles.badge, { backgroundColor: style?.background ?? colors.cream }]}>
                  <Text style={[styles.badgeText, { color }]}>{statusLabel(event.status)}</Text>
                </View>
                {previous ? <Text style={styles.delay}>+{elapsed(previous.created_at, event.created_at)}</Text> : null}
              </View>
              <Text style={[ui.small, { marginTop: 2 }]}>par {actor}</Text>
              {event.note ? <Text style={styles.note}>{event.note}</Text> : null}
            </View>
          </View>
        </View>;
      })}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  box: { marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 },
  day: { color: colors.muted, fontSize: 11, fontWeight: "800", textTransform: "uppercase", marginTop: 6, marginBottom: 4, marginLeft: 52 },
  row: { flexDirection: "row", alignItems: "stretch" },
  time: { width: 44, color: colors.text, fontSize: 12, fontWeight: "700", textAlign: "right", paddingTop: 2 },
  rail: { width: 24, alignItems: "center" },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 4, borderWidth: 2, borderColor: colors.white },
  dotCurrent: { width: 14, height: 14, borderRadius: 7, marginTop: 3 },
  line: { flex: 1, width: 2, backgroundColor: colors.line, marginTop: 2 },
  body: { flex: 1, paddingBottom: 12 },
  badge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: "800" },
  delay: { color: colors.muted, fontSize: 11, fontWeight: "700" },
  note: { color: colors.text, fontSize: 12, marginTop: 3, backgroundColor: colors.cream, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
});
