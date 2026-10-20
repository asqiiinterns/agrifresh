import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import type { HomeLayout } from "../data/account";
import { Button, CloseButton, ScreenHeader } from "../ui/components";
import type { IconName } from "../ui/navigation";
import { colors, ui } from "../ui/theme";

type Item = { key: string; label: string; icon: IconName };

// Pick which figures and shortcuts the home screen shows, and in which order.
export function HomeEditor({ visible, title, tiles, shortcuts, value, onSave, onReset, resetLabel, onClose }: {
  visible: boolean;
  title: string;
  tiles: Item[];
  shortcuts: Item[];
  value: HomeLayout;
  onSave: (layout: HomeLayout) => Promise<void>;
  onReset: () => Promise<void>;
  resetLabel: string;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<HomeLayout>(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setLayout(value);
    setError("");
  }, [visible]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enregistrement impossible.");
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="ACCUEIL" title={title} right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content}>
        <Text style={[ui.small, { marginTop: 8 }]}>Cochez ce qui doit apparaître et réglez l’ordre avec ▲ ▼. Seuls les éléments autorisés pour chaque profil s’affichent.</Text>
        <Section title="Chiffres" items={tiles} selected={layout.tiles} onChange={(next) => setLayout({ ...layout, tiles: next })} />
        <Section title="Raccourcis" items={shortcuts} selected={layout.shortcuts} onChange={(next) => setLayout({ ...layout, shortcuts: next })} />
        {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
        <Button label="ENREGISTRER" onPress={() => run(() => onSave(layout))} busy={busy} style={{ marginTop: 14 }} />
        <Button label={resetLabel} variant="secondary" onPress={() => run(onReset)} disabled={busy} style={{ marginTop: 8 }} />
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

function Section({ title, items, selected, onChange }: { title: string; items: Item[]; selected: string[]; onChange: (keys: string[]) => void }) {
  // Selected items first, in their order, then the others.
  const ordered = [...selected.map((key) => items.find((item) => item.key === key)).filter((item): item is Item => !!item), ...items.filter((item) => !selected.includes(item.key))];
  const move = (key: string, delta: number) => {
    const index = selected.indexOf(key), target = index + delta;
    if (index < 0 || target < 0 || target >= selected.length) return;
    const next = [...selected];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return <View style={{ marginTop: 14 }}>
    <Text style={styles.title}>{title.toLocaleUpperCase("fr")}</Text>
    <View style={styles.group}>
      {ordered.map((item) => {
        const on = selected.includes(item.key);
        const index = selected.indexOf(item.key);
        return <View key={item.key} style={styles.row}>
          <Pressable onPress={() => onChange(on ? selected.filter((key) => key !== item.key) : [...selected, item.key])} style={styles.check} hitSlop={6}>
            <Ionicons name={on ? "checkbox" : "square-outline"} size={22} color={on ? colors.primary : colors.muted} />
          </Pressable>
          <Ionicons name={item.icon} size={16} color={on ? colors.primary : colors.muted} />
          <Text style={[ui.body, { flex: 1 }, !on && { color: colors.muted }]}>{item.label}</Text>
          {on ? <>
            <Pressable onPress={() => move(item.key, -1)} disabled={index === 0} style={[styles.arrow, index === 0 && ui.disabled]}><Text style={styles.arrowText}>▲</Text></Pressable>
            <Pressable onPress={() => move(item.key, 1)} disabled={index === selected.length - 1} style={[styles.arrow, index === selected.length - 1 && ui.disabled]}><Text style={styles.arrowText}>▼</Text></Pressable>
          </> : null}
        </View>;
      })}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  title: { color: colors.textSoft, fontSize: 10, fontWeight: "800", letterSpacing: 1, marginBottom: 5 },
  group: { backgroundColor: colors.white, borderRadius: 10, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.line },
  check: { padding: 2 },
  arrow: { width: 32, height: 28, borderRadius: 6, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  arrowText: { color: colors.primary, fontSize: 11 },
});
