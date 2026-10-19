import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text, TextInput } from "./Text";
import { colors, ui } from "./theme";

export const formatPrice = (amount: number | string) =>
  `${new Intl.NumberFormat("fr-TN", { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Number(amount))} TND`;

export const formatQuantity = (quantity: number | string) =>
  new Intl.NumberFormat("fr-TN", { maximumFractionDigits: 3 }).format(Number(quantity));

// Dates without a time part ("2026-10-18") are calendar days, not UTC instants.
export function formatDay(value: string | Date, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) {
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return date.toLocaleDateString("fr-TN", options);
}

export const formatDateTime = (value: string) =>
  new Date(value).toLocaleString("fr-TN", { dateStyle: "medium", timeStyle: "short" });

export const toDayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const statusStyles: Record<string, { label: string; color: string; background: string }> = {
  pending: { label: "Nouvelle", color: "#7a5a12", background: "#fbf0d5" },
  on_hold: { label: "En attente", color: colors.amber, background: "#fdf3e1" },
  confirmed: { label: "Acceptée", color: colors.green, background: "#e6efe4" },
  declined: { label: "Déclinée", color: colors.danger, background: "#f8e5e1" },
  awaiting_client: { label: "À reconfirmer", color: "#9a4f0f", background: "#fde7d4" },
  preparing: { label: "En préparation", color: "#2f5d8a", background: "#e3edf7" },
  ready: { label: "Préparée", color: "#2f5d8a", background: "#e3edf7" },
  out_for_delivery: { label: "Expédiée", color: "#5b3f8a", background: "#ece6f6" },
  delivered: { label: "Livrée", color: colors.green, background: "#dcebd7" },
  cancelled: { label: "Annulée", color: colors.danger, background: "#f8e5e1" },
};

export const statusLabel = (status: string) => statusStyles[status]?.label ?? status;

export function StatusBadge({ status }: { status: string }) {
  const style = statusStyles[status] ?? { label: status, color: colors.muted, background: colors.cream };
  return <View style={[ui.badge, { backgroundColor: style.background }]}><Text style={[ui.badgeText, { color: style.color }]}>{style.label}</Text></View>;
}

export function ScreenHeader({ eyebrow, title, subtitle, right }: { eyebrow: string; title: string; subtitle?: string; right?: ReactNode }) {
  return <View style={[ui.header, ui.row]}>
    <View style={{ flex: 1 }}>
      <Text style={ui.eyebrow}>{eyebrow}</Text>
      <Text style={ui.title}>{title}</Text>
      {subtitle ? <Text style={ui.subtitle}>{subtitle}</Text> : null}
    </View>
    {right}
  </View>;
}

export function CloseButton({ onPress }: { onPress: () => void }) {
  return <Pressable onPress={onPress} style={ui.closeButton} accessibilityLabel="Fermer"><Text style={ui.closeText}>×</Text></Pressable>;
}

export function Field({ label, ...props }: { label: string } & ComponentProps<typeof TextInput>) {
  return <View style={ui.field}>
    <Text style={ui.fieldLabel}>{label}</Text>
    <TextInput style={[ui.input, props.multiline && { minHeight: 70, textAlignVertical: "top" }]} placeholderTextColor={colors.muted} autoCorrect={false} {...props} />
  </View>;
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return <Pressable onPress={onPress} style={[ui.chip, selected && ui.chipSelected]}>
    <Text style={[ui.chipText, selected && ui.chipTextSelected]}>{label}</Text>
  </Pressable>;
}

export function Button({ label, onPress, variant = "primary", busy, disabled, style }: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  busy?: boolean;
  disabled?: boolean;
  style?: ComponentProps<typeof View>["style"];
}) {
  const primary = variant === "primary";
  return <Pressable
    onPress={onPress}
    disabled={disabled || busy}
    style={[primary ? ui.primaryButton : ui.secondaryButton, variant === "danger" && ui.dangerButton, (disabled || busy) && ui.disabled, style]}
  >
    {busy ? <ActivityIndicator color={primary ? colors.white : colors.green} /> : <Text style={[primary ? ui.primaryButtonText : ui.secondaryButtonText, variant === "danger" && ui.dangerButtonText]}>{label}</Text>}
  </Pressable>;
}

export function Loading({ label = "Chargement…" }: { label?: string }) {
  return <View style={[ui.empty, { gap: 10 }]}><ActivityIndicator color={colors.green} /><Text style={ui.small}>{label}</Text></View>;
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return <View style={ui.empty}>
    <Text style={ui.emptyTitle}>{title}</Text>
    {body ? <Text style={ui.emptyBody}>{body}</Text> : null}
    {action ? <View style={{ marginTop: 16 }}>{action}</View> : null}
  </View>;
}

// Sheets at the top of a screen (e.g. "En cours" / "Clôturées"), as a segmented control.
export function Sheets<K extends string>({ items, value, onChange }: { items: { key: K; label: string; count?: number }[]; value: K; onChange: (key: K) => void }) {
  return <View style={local.sheetsWrap}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={local.sheets}>
      {items.map((item) => {
        const selected = item.key === value;
        return <Pressable key={item.key} onPress={() => onChange(item.key)} style={[local.sheet, selected && local.sheetSelected]} accessibilityRole="tab" accessibilityState={{ selected }}>
          <Text style={[local.sheetText, selected && local.sheetTextSelected]}>{item.label}</Text>
          {item.count !== undefined ? <View style={[local.sheetCount, selected && local.sheetCountSelected]}><Text style={[local.sheetCountText, selected && { color: colors.green }]}>{item.count}</Text></View> : null}
        </Pressable>;
      })}
    </ScrollView>
  </View>;
}

// Inherit / yes / no, used wherever a value can follow a default (role, all clients).
export function TriState({ value, inherited, onChange, inheritLabel = "Défaut", disabled }: {
  value: boolean | null;
  inherited: boolean;
  onChange: (value: boolean | null) => void;
  inheritLabel?: string;
  disabled?: boolean;
}) {
  const options: { key: "inherit" | "yes" | "no"; label: string; value: boolean | null }[] = [
    { key: "inherit", label: `${inheritLabel} (${inherited ? "oui" : "non"})`, value: null },
    { key: "yes", label: "Oui", value: true },
    { key: "no", label: "Non", value: false },
  ];
  return <View style={[local.tri, disabled && ui.disabled]}>
    {options.map((option) => {
      const selected = option.value === value;
      return <Pressable key={option.key} disabled={disabled} onPress={() => onChange(option.value)} style={[local.triItem, selected && (option.value === null ? local.triInherit : option.value ? local.triYes : local.triNo)]}>
        <Text style={[local.triText, selected && { color: option.value === null ? colors.text : colors.white, fontWeight: "800" }]} numberOfLines={1}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

// One line of a menu or a list: icon, title, optional detail, chevron.
export function ListRow({ icon, title, detail, onPress, right, badge }: { icon?: ComponentProps<typeof Ionicons>["name"]; title: string; detail?: string; onPress?: () => void; right?: ReactNode; badge?: number }) {
  return <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [local.listRow, pressed && { opacity: 0.7 }]}>
    {icon ? <View style={local.listIcon}><Ionicons name={icon} size={18} color={colors.green} /></View> : null}
    <View style={{ flex: 1 }}>
      <Text style={ui.strong} numberOfLines={1}>{title}</Text>
      {detail ? <Text style={ui.small} numberOfLines={2}>{detail}</Text> : null}
    </View>
    {badge ? <View style={local.badge}><Text style={local.badgeText}>{badge > 99 ? "99+" : badge}</Text></View> : null}
    {right ?? (onPress ? <Ionicons name="chevron-forward" size={16} color={colors.muted} /> : null)}
  </Pressable>;
}

// Group of ListRow inside one rounded box.
export function ListGroup({ title, children }: { title?: string; children: ReactNode }) {
  return <View style={{ marginTop: 12 }}>
    {title ? <Text style={local.groupTitle}>{title.toLocaleUpperCase("fr")}</Text> : null}
    <View style={local.group}>{children}</View>
  </View>;
}

export function BackButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={local.back} accessibilityLabel="Retour" hitSlop={6}>
    <Ionicons name="chevron-back" size={14} color={colors.green} />
    <Text style={local.backText}>{label}</Text>
  </Pressable>;
}

const local = StyleSheet.create({
  sheetsWrap: { borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.paper },
  sheets: { paddingHorizontal: 14, paddingVertical: 6, gap: 6 },
  sheet: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  sheetSelected: { backgroundColor: colors.green },
  sheetText: { color: "#5f685d", fontSize: 12, fontWeight: "700" },
  sheetTextSelected: { color: colors.white },
  sheetCount: { minWidth: 20, paddingHorizontal: 5, height: 18, borderRadius: 9, backgroundColor: "#ecebe4", alignItems: "center", justifyContent: "center" },
  sheetCountSelected: { backgroundColor: colors.white },
  sheetCountText: { color: "#5f685d", fontSize: 10, fontWeight: "800" },
  tri: { flexDirection: "row", borderWidth: 1, borderColor: colors.line, borderRadius: 8, overflow: "hidden", marginTop: 6, backgroundColor: colors.white },
  triItem: { flex: 1, paddingVertical: 6, paddingHorizontal: 4, alignItems: "center", borderRightWidth: 1, borderRightColor: colors.line },
  triInherit: { backgroundColor: "#ecebe4" },
  triYes: { backgroundColor: colors.green },
  triNo: { backgroundColor: colors.danger },
  triText: { color: "#5f685d", fontSize: 11, fontWeight: "600" },
  listRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.white },
  listIcon: { width: 30, height: 30, borderRadius: 8, backgroundColor: "#e6efe4", alignItems: "center", justifyContent: "center" },
  group: { backgroundColor: colors.white, borderRadius: 10, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  groupTitle: { color: "#6f7a6b", fontSize: 10, fontWeight: "800", letterSpacing: 1, marginBottom: 5, marginLeft: 2 },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center" },
  badgeText: { color: colors.white, fontSize: 10, fontWeight: "800" },
  back: { flexDirection: "row", alignItems: "center", gap: 2, borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.white },
  backText: { color: colors.green, fontSize: 12, fontWeight: "800" },
});

export function ProductImage({ uri, style }: { uri: string; style: ComponentProps<typeof Image>["style"] }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  if (failed || !uri) {
    return <View style={[style, { backgroundColor: colors.cream, alignItems: "center", justifyContent: "center" }]}>
      <Text style={{ color: colors.green, fontSize: 22, opacity: 0.6 }}>✿</Text>
    </View>;
  }
  return <Image source={{ uri }} style={style} onError={() => setFailed(true)} />;
}
