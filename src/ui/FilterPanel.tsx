import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Chip } from "./components";
import { colors, ui } from "./theme";

export type FilterOption = { key: string; label: string; count?: number };
export type FilterGroup = {
  title: string;
  options: FilterOption[];
  value: string;
  defaultValue: string;
  onChange: (value: string) => void;
};

// One search field plus a "Filtres" button that opens titled groups of choices;
// active filters are summed up in plain words with a single "Effacer".
export function FilterPanel({ search, onSearch, placeholder, groups }: {
  search?: string;
  onSearch?: (value: string) => void;
  placeholder?: string;
  groups: FilterGroup[];
}) {
  const [open, setOpen] = useState(false);
  const active = groups.filter((group) => group.value !== group.defaultValue);
  const summary = active.map((group) => group.options.find((option) => option.key === group.value)?.label).filter(Boolean).join(" · ");

  return <View style={styles.wrap}>
    <View style={styles.row}>
      {onSearch ? <TextInput value={search} onChangeText={onSearch} placeholder={placeholder ?? "Rechercher"} placeholderTextColor={colors.muted} style={[ui.input, { flex: 1 }]} /> : <View style={{ flex: 1 }} />}
      {groups.length ? <Pressable onPress={() => setOpen((value) => !value)} style={[styles.toggle, (open || active.length > 0) && styles.toggleActive]}>
        <Text style={[styles.toggleText, (open || active.length > 0) && styles.toggleTextActive]}>Filtres{active.length ? ` (${active.length})` : ""} {open ? "▴" : "▾"}</Text>
      </Pressable> : null}
    </View>

    {open ? <View style={styles.panel}>
      {groups.map((group) => <View key={group.title} style={{ marginTop: 8 }}>
        <Text style={styles.groupTitle}>{group.title}</Text>
        <View style={[ui.wrapRow, { marginTop: 6 }]}>
          {group.options.map((option) => <Chip
            key={option.key}
            label={option.count === undefined ? option.label : `${option.label} (${option.count})`}
            selected={group.value === option.key}
            onPress={() => group.onChange(option.key)}
          />)}
        </View>
      </View>)}
      <Pressable onPress={() => setOpen(false)} style={{ alignSelf: "flex-end", marginTop: 10 }}><Text style={styles.link}>Fermer</Text></Pressable>
    </View> : null}

    {active.length ? <View style={[ui.row, { marginTop: 6 }]}>
      <Text style={[ui.small, { flex: 1 }]} numberOfLines={2}>Filtré : <Text style={{ color: colors.text, fontWeight: "700" }}>{summary}</Text></Text>
      <Pressable onPress={() => groups.forEach((group) => group.onChange(group.defaultValue))} hitSlop={8}><Text style={styles.link}>Effacer</Text></Pressable>
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 18, paddingTop: 10 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  toggle: { borderWidth: 1, borderColor: colors.line, borderRadius: 7, paddingHorizontal: 12, minHeight: 44, justifyContent: "center", backgroundColor: colors.white },
  toggleActive: { borderColor: colors.green },
  toggleText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  toggleTextActive: { color: colors.green },
  panel: { marginTop: 8, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  groupTitle: { color: "#405447", fontSize: 11, fontWeight: "800", letterSpacing: 0.4 },
  link: { color: colors.green, fontSize: 12, fontWeight: "800" },
});
