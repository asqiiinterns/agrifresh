import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "./Text";
import { SafeAreaView } from "react-native-safe-area-context";
import { Calendar } from "./Calendar";
import { Button, CloseButton, ScreenHeader } from "./components";
import { rangeLabel, type DateFilterValue, type DatePreset } from "./dateFilter";
import { colors, ui } from "./theme";

export type ChoiceFilter = {
  kind: "choice";
  title: string;
  options: { key: string; label: string; count?: number }[];
  value: string;
  defaultValue: string;
  onChange: (value: string) => void;
};

export type DateFilter = {
  kind: "date";
  title: string;
  presets: DatePreset[];
  value: DateFilterValue;
  onChange: (value: DateFilterValue) => void;
};

export type Filter = ChoiceFilter | DateFilter;

const isActive = (filter: Filter) => filter.kind === "choice" ? filter.value !== filter.defaultValue : filter.value !== null;
const valueLabel = (filter: Filter) => filter.kind === "choice"
  ? filter.options.find((option) => option.key === filter.value)?.label ?? ""
  : filter.value?.label ?? "Toutes";

// Search field + one button per filter showing its current value ("Livraison : Demain ▾").
// A button opens a sheet with the choices; date filters add shortcuts and a calendar.
export function FilterBar({ search, onSearch, placeholder, filters }: {
  search?: string;
  onSearch?: (value: string) => void;
  placeholder?: string;
  filters: Filter[];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const activeCount = filters.filter(isActive).length;
  const reset = (filter: Filter) => filter.kind === "choice" ? filter.onChange(filter.defaultValue) : filter.onChange(null);

  return <View style={styles.wrap}>
    {onSearch ? <TextInput value={search} onChangeText={onSearch} placeholder={placeholder ?? "Rechercher"} placeholderTextColor={colors.muted} style={ui.input} clearButtonMode="while-editing" /> : null}
    {filters.length ? <View style={styles.buttons}>
      {filters.map((filter, index) => {
        const active = isActive(filter);
        return <View key={filter.title} style={[styles.button, active && styles.buttonActive]}>
          <Pressable onPress={() => setOpen(index)} style={styles.buttonMain} accessibilityLabel={`Filtre ${filter.title}`}>
            {filter.kind === "date" ? <Text style={[styles.icon, active && styles.textActive]}>📅</Text> : null}
            <Text style={[styles.buttonText, active && styles.textActive]} numberOfLines={1}>{filter.title} : <Text style={{ fontWeight: "800" }}>{valueLabel(filter)}</Text></Text>
            {!active ? <Text style={styles.caret}>▾</Text> : null}
          </Pressable>
          {active ? <Pressable onPress={() => reset(filter)} hitSlop={8} style={styles.clear} accessibilityLabel={`Retirer le filtre ${filter.title}`}><Text style={styles.clearText}>✕</Text></Pressable> : null}
        </View>;
      })}
      {activeCount > 1 ? <Pressable onPress={() => filters.forEach(reset)} style={styles.resetAll}><Text style={styles.resetText}>Tout effacer</Text></Pressable> : null}
    </View> : null}
    <FilterSheet filter={open === null ? null : filters.at(open) ?? null} onClose={() => setOpen(null)} />
  </View>;
}

function FilterSheet({ filter, onClose }: { filter: Filter | null; onClose: () => void }) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);

  function close() {
    setCalendarOpen(false);
    setRange(null);
    onClose();
  }

  return <Modal visible={filter !== null} animationType="slide" presentationStyle="pageSheet" transparent={false} onRequestClose={close}>
    <SafeAreaView style={ui.modalSafe}>
      {filter ? <>
        <ScreenHeader eyebrow="FILTRER" title={filter.title} right={<CloseButton onPress={close} />} />
        <ScrollView contentContainerStyle={ui.content}>
          {filter.kind === "choice" ? filter.options.map((option) => {
            const selected = option.key === filter.value;
            return <Pressable key={option.key} onPress={() => { filter.onChange(option.key); close(); }} style={[styles.option, selected && styles.optionSelected]}>
              <View style={[styles.radio, selected && styles.radioOn]} />
              <Text style={[ui.body, { flex: 1 }, selected && { fontWeight: "800" }]}>{option.label}</Text>
              {option.count !== undefined ? <Text style={ui.small}>{option.count}</Text> : null}
            </Pressable>;
          }) : <>
            <Pressable onPress={() => { filter.onChange(null); close(); }} style={[styles.option, filter.value === null && styles.optionSelected]}>
              <View style={[styles.radio, filter.value === null && styles.radioOn]} />
              <Text style={[ui.body, { flex: 1 }]}>Toutes les dates</Text>
            </Pressable>
            {filter.presets.map((preset) => {
              const selected = filter.value?.label === preset.label;
              return <Pressable key={preset.label} onPress={() => { filter.onChange(preset.value()); close(); }} style={[styles.option, selected && styles.optionSelected]}>
                <View style={[styles.radio, selected && styles.radioOn]} />
                <Text style={[ui.body, { flex: 1 }, selected && { fontWeight: "800" }]}>{preset.label}</Text>
              </Pressable>;
            })}
            <Pressable onPress={() => setCalendarOpen((value) => !value)} style={[styles.option, calendarOpen && styles.optionSelected]}>
              <Text style={styles.icon}>📅</Text>
              <Text style={[ui.body, { flex: 1, fontWeight: "700" }]}>Choisir dans le calendrier…</Text>
            </Pressable>
            {calendarOpen ? <View style={[ui.card, { marginTop: 8 }]}>
              <Calendar from={range?.from ?? filter.value?.from} to={range?.to ?? filter.value?.to} onChange={(from, to) => setRange({ from, to })} />
              <Button
                label={range ? `APPLIQUER : ${rangeLabel(range.from, range.to)}` : "CHOISISSEZ UN JOUR"}
                disabled={!range}
                onPress={() => { if (range) { filter.onChange({ label: rangeLabel(range.from, range.to), from: range.from, to: range.to }); close(); } }}
                style={{ marginTop: 12 }}
              />
            </View> : null}
          </>}
        </ScrollView>
      </> : null}
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 18, paddingTop: 10, gap: 8 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingVertical: 2 },
  button: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.line, borderRadius: 20, backgroundColor: colors.white, maxWidth: 300 },
  buttonActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  buttonMain: { flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 12, paddingRight: 10, paddingVertical: 8, flexShrink: 1 },
  buttonText: { color: colors.text, fontSize: 12, flexShrink: 1 },
  textActive: { color: colors.primary },
  icon: { fontSize: 12 },
  caret: { color: colors.muted, fontSize: 11 },
  clear: { paddingRight: 12, paddingLeft: 2, paddingVertical: 8 },
  clearText: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  resetAll: { justifyContent: "center", paddingHorizontal: 6 },
  resetText: { color: colors.danger, fontSize: 12, fontWeight: "700" },
  option: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
  optionSelected: { backgroundColor: colors.primarySoft },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.line },
  radioOn: { borderColor: colors.primary, backgroundColor: colors.primary },
});
