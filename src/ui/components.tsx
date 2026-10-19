import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, View } from "react-native";
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
