import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { toDayKey } from "./components";
import { colors, ui } from "./theme";
import { appLocale } from "./i18n";

const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];

// Month grid: first tap = start day, second tap = end day (a single day if the same).
export function Calendar({ from, to, onChange }: { from?: string; to?: string; onChange: (from: string, to: string) => void }) {
  const initial = from ? new Date(`${from}T12:00:00`) : new Date();
  const [month, setMonth] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1));
  const [pending, setPending] = useState<string | null>(null);

  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // Monday first
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells: (string | null)[] = Array.from({ length: offset }, () => null);
    for (let day = 1; day <= count; day += 1) cells.push(toDayKey(new Date(month.getFullYear(), month.getMonth(), day)));
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [month]);

  const today = toDayKey(new Date());
  const start = pending ?? from;
  const end = pending ? pending : to;

  function pick(day: string) {
    if (!pending) {
      setPending(day);
      onChange(day, day);
      return;
    }
    const [a, b] = day < pending ? [day, pending] : [pending, day];
    setPending(null);
    onChange(a, b);
  }

  const title = month.toLocaleDateString(appLocale(), { month: "long", year: "numeric" });
  const rows = Array.from({ length: days.length / 7 }, (_, index) => days.slice(index * 7, index * 7 + 7));

  return <View>
    <View style={[ui.row, { marginBottom: 8 }]}>
      <Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} style={styles.nav} accessibilityLabel="Mois précédent"><Text style={styles.navText}>‹</Text></Pressable>
      <Text style={[ui.strong, { textTransform: "capitalize" }]}>{title}</Text>
      <Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} style={styles.nav} accessibilityLabel="Mois suivant"><Text style={styles.navText}>›</Text></Pressable>
    </View>
    <View style={styles.week}>{WEEKDAYS.map((label, index) => <Text key={index} style={styles.weekday}>{label}</Text>)}</View>
    {rows.map((row, rowIndex) => <View key={rowIndex} style={styles.week}>
      {row.map((day, index) => {
        if (!day) return <View key={index} style={styles.cell} />;
        const edge = day === start || day === end;
        const inside = !!start && !!end && day > start && day < end;
        return <Pressable key={day} onPress={() => pick(day)} style={[styles.cell, inside && styles.inside, edge && styles.edge]}>
          <Text style={[styles.dayText, day === today && styles.today, edge && styles.edgeText]}>{Number(day.slice(8))}</Text>
        </Pressable>;
      })}
    </View>)}
    <Text style={[ui.small, { marginTop: 8 }]}>{pending ? "Touchez le dernier jour de la période (ou le même jour)." : "Touchez un jour, puis un second pour une période."}</Text>
  </View>;
}

const styles = StyleSheet.create({
  nav: { width: 40, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 8, borderWidth: 1, borderColor: colors.line },
  navText: { color: colors.primary, fontSize: 22, lineHeight: 24 },
  week: { flexDirection: "row" },
  weekday: { flex: 1, textAlign: "center", color: colors.muted, fontSize: 11, fontWeight: "700", paddingVertical: 4 },
  cell: { flex: 1, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  inside: { backgroundColor: colors.primarySoft, borderRadius: 0 },
  edge: { backgroundColor: colors.primary },
  dayText: { color: colors.text, fontSize: 14 },
  today: { fontWeight: "800", textDecorationLine: "underline" },
  edgeText: { color: colors.white, fontWeight: "800" },
});
