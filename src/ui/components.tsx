import { Children, createContext, isValidElement, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text, TextInput } from "./Text";
import { colors, ui } from "./theme";
import { appLocale, tr } from "./i18n";

export const formatPrice = (amount: number | string) =>
  `${new Intl.NumberFormat(appLocale(), { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Number(amount))} TND`;

export const formatQuantity = (quantity: number | string) =>
  new Intl.NumberFormat(appLocale(), { maximumFractionDigits: 3 }).format(Number(quantity));

// Dates without a time part ("2026-10-18") are calendar days, not UTC instants.
export function formatDay(value: string | Date, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) {
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return date.toLocaleDateString(appLocale(), options);
}

export const formatDateTime = (value: string) =>
  new Date(value).toLocaleString(appLocale(), { dateStyle: "medium", timeStyle: "short" });

export const toDayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

// One colour per step of the workflow, the same for the team and for clients.
export const statusStyles: Record<string, { label: string; color: string; background: string }> = {
  pending: { label: "Nouvelle", color: "#7a5a12", background: "#fbefc9" },
  on_hold: { label: "En attente", color: "#8a4b08", background: "#fde3c8" },
  awaiting_client: { label: "À reconfirmer", color: "#9a3412", background: "#fdd5c0" },
  confirmed: { label: "Acceptée", color: "#1e4f8f", background: "#dbe7f8" },
  preparing: { label: "En préparation", color: "#0f6b64", background: "#d3f0ec" },
  ready: { label: "Préparée", color: "#3f3aa8", background: "#e3e2fa" },
  out_for_delivery: { label: "Expédiée", color: "#76289f", background: "#f0e2fa" },
  delivered: { label: "Livrée", color: "#1d6b36", background: "#d6efdc" },
  declined: { label: "Déclinée", color: colors.danger, background: "#f8e2dd" },
  cancelled: { label: "Annulée", color: "#5f6560", background: "#e9eae7" },
};

// Client-friendly progress: received → accepted → in preparation → shipped → delivered.
const progressSteps = [
  { key: "received", label: "Reçue", statuses: ["pending", "on_hold", "awaiting_client"] },
  { key: "accepted", label: "Acceptée", statuses: ["confirmed"] },
  { key: "preparing", label: "Préparation", statuses: ["preparing", "ready"] },
  { key: "shipped", label: "En route", statuses: ["out_for_delivery"] },
  { key: "delivered", label: "Livrée", statuses: ["delivered"] },
];
const stepColors = ["#c9a227", "#1e4f8f", "#0f6b64", "#76289f", "#1d6b36"];

export function OrderProgress({ status }: { status: string }) {
  if (status === "declined" || status === "cancelled") return null;
  const index = progressSteps.findIndex((step) => step.statuses.includes(status));
  return <View style={local.progress}>
    {progressSteps.map((step, position) => {
      const done = position <= index;
      return <View key={step.key} style={{ flex: 1 }}>
        <View style={[local.progressBar, { backgroundColor: done ? stepColors[Math.max(index, 0)] : colors.line }]} />
        <Text style={[local.progressLabel, position === index && { color: stepColors[index], fontWeight: "800" }]} numberOfLines={1}>{step.label}</Text>
      </View>;
    })}
  </View>;
}

export const statusLabel = (status: string) => statusStyles[status]?.label ?? status;

export function StatusBadge({ status }: { status: string }) {
  const style = statusStyles[status] ?? { label: status, color: colors.muted, background: colors.cream };
  return <View style={[ui.badge, local.statusBadge, { backgroundColor: style.background }]}>
    <View style={[local.statusDot, { backgroundColor: style.color }]} />
    <Text style={[ui.badgeText, { color: style.color }]}>{style.label}</Text>
  </View>;
}

export function ScreenHeader({ eyebrow, title, subtitle, right }: { eyebrow: string; title: string; subtitle?: string; right?: ReactNode }) {
  return <View style={ui.header}>
    <View style={[ui.row, ui.pageInner]}>
      <View style={{ flex: 1 }}>
        <Text style={ui.eyebrow}>{eyebrow}</Text>
        <Text style={ui.title}>{title}</Text>
        {subtitle ? <Text style={ui.subtitle}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  </View>;
}

export function CloseButton({ onPress }: { onPress: () => void }) {
  return <Pressable onPress={onPress} style={ui.closeButton} accessibilityLabel="Fermer"><Text style={ui.closeText}>×</Text></Pressable>;
}

export function Field({ label, ...props }: { label: string } & ComponentProps<typeof TextInput>) {
  // Password fields: an eye shows or hides what was typed.
  const [shown, setShown] = useState(false);
  const secret = !!props.secureTextEntry;
  const input = <TextInput style={[ui.input, props.multiline && { minHeight: 70, textAlignVertical: "top" }, secret && { paddingRight: 44 }]} placeholderTextColor={colors.muted} autoCorrect={false} {...props} secureTextEntry={secret && !shown} />;
  return <View style={ui.field}>
    <Text style={ui.fieldLabel}>{label}</Text>
    {secret ? <View style={{ justifyContent: "center" }}>
      {input}
      <Pressable onPress={() => setShown((value) => !value)} hitSlop={8} accessibilityRole="button" accessibilityLabel={shown ? "Masquer le mot de passe" : "Afficher le mot de passe"} style={{ position: "absolute", right: 10, padding: 4 }}>
        <Ionicons name={shown ? "eye-off-outline" : "eye-outline"} size={20} color={colors.muted} />
      </Pressable>
    </View> : input}
  </View>;
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return <Pressable onPress={onPress} style={[ui.chip, selected && ui.chipSelected]}>
    <Text style={[ui.chipText, selected && ui.chipTextSelected]}>{label}</Text>
  </Pressable>;
}

// Anti double-submit: while the action returned by onPress runs (or for a short moment after a
// synchronous one), further taps are ignored and the button shows a spinner.
export function Button({ label, onPress, variant = "primary", busy, disabled, style, color }: {
  label: string;
  onPress: () => unknown;
  variant?: "primary" | "secondary" | "danger";
  busy?: boolean;
  disabled?: boolean;
  style?: ComponentProps<typeof View>["style"];
  // A primary button in another colour (e.g. the colour of the order step it leads to).
  color?: string;
}) {
  const primary = variant === "primary";
  const locked = useRef(false);
  const [running, setRunning] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  function press() {
    if (locked.current || busy || disabled) return;
    locked.current = true;
    let result: unknown;
    try { result = onPress(); } catch (cause) { locked.current = false; throw cause; }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      setRunning(true);
      void Promise.resolve(result).catch(() => undefined).finally(() => { locked.current = false; if (mounted.current) setRunning(false); });
    } else {
      setTimeout(() => { locked.current = false; }, 600);
    }
  }
  const waiting = busy || running;
  return <Pressable
    onPress={press}
    disabled={disabled || waiting}
    style={[primary ? ui.primaryButton : ui.secondaryButton, variant === "danger" && ui.dangerButton, primary && color ? { backgroundColor: color, borderColor: color } : null, (disabled || waiting) && ui.disabled, style]}
  >
    {waiting ? <ActivityIndicator color={primary ? colors.white : colors.primary} /> : <Text style={[primary ? ui.primaryButtonText : ui.secondaryButtonText, variant === "danger" && ui.dangerButtonText]}>{label}</Text>}
  </Pressable>;
}

export function Loading({ label = "Chargement…" }: { label?: string }) {
  return <View style={[ui.empty, { gap: 10 }]}><ActivityIndicator color={colors.primary} /><Text style={ui.small}>{label}</Text></View>;
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
    <View style={local.sheets}>
      {items.map((item) => {
        const selected = item.key === value;
        return <Pressable key={item.key} onPress={() => onChange(item.key)} style={[local.sheet, selected && local.sheetSelected]} accessibilityRole="tab" accessibilityState={{ selected }}>
          <Text style={[local.sheetText, selected && local.sheetTextSelected]}>{item.label}</Text>
          {item.count !== undefined ? <View style={[local.sheetCount, selected && local.sheetCountSelected]}><Text style={[local.sheetCountText, selected && { color: colors.primary }]}>{item.count}</Text></View> : null}
        </Pressable>;
      })}
    </View>
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
// Menu search: inside <MenuSearch>, rows whose title and detail do not match are hidden
// (French and the chosen language), and so are groups left empty.
const MenuQuery = createContext("");
const foldText = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
const rowMatches = (needle: string, title?: unknown, detail?: unknown, keywords?: unknown) => {
  if (!needle) return true;
  const parts = [title, detail, keywords].filter((part): part is string => typeof part === "string");
  return foldText(parts.flatMap((part) => [part, tr(part)]).join(" ")).includes(needle);
};

export function MenuSearch({ children, placeholder = "Rechercher un réglage" }: { children: ReactNode; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const needle = foldText(query.trim());
  return <MenuQuery.Provider value={needle}>
    <TextInput value={query} onChangeText={setQuery} placeholder={placeholder} placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 10 }]} autoCorrect={false} clearButtonMode="while-editing" />
    {children}
  </MenuQuery.Provider>;
}

// leading: a control shown before the text (a switch), so it is never far from what it changes.
export function ListRow({ icon, title, detail, onPress, right, badge, keywords, leading }: { icon?: ComponentProps<typeof Ionicons>["name"]; title: string; detail?: string; onPress?: () => void; right?: ReactNode; badge?: number; keywords?: string; leading?: ReactNode }) {
  const needle = useContext(MenuQuery);
  if (needle && onPress && !rowMatches(needle, title, detail, keywords)) return null;
  return <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [local.listRow, pressed && { opacity: 0.7 }]}>
    {leading}
    {icon ? <View style={local.listIcon}><Ionicons name={icon} size={18} color={colors.primary} /></View> : null}
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
  const needle = useContext(MenuQuery);
  if (needle && !rowMatches(needle, title)) {
    // Searching: keep the group only if one of its rows matches (a matching group title keeps all).
    const rows = Children.toArray(children).filter(isValidElement) as { props: { title?: unknown; detail?: unknown; keywords?: unknown; onPress?: unknown } }[];
    if (!rows.some((row) => !row.props.onPress || rowMatches(needle, row.props.title, row.props.detail, row.props.keywords))) return null;
  }
  return <View style={{ marginTop: 12 }}>
    {title ? <Text style={local.groupTitle}>{title.toLocaleUpperCase("fr")}</Text> : null}
    <View style={local.group}>{children}</View>
  </View>;
}

export function BackButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={local.back} accessibilityLabel="Retour" hitSlop={6}>
    <Ionicons name="chevron-back" size={14} color={colors.primary} />
    <Text style={local.backText}>{label}</Text>
  </Pressable>;
}

const local = StyleSheet.create({
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 5 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  progress: { flexDirection: "row", gap: 4, marginTop: 8 },
  progressBar: { height: 4, borderRadius: 2 },
  progressLabel: { color: colors.muted, fontSize: 9, marginTop: 3, textAlign: "center" },
  sheetsWrap: { borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.paper },
  sheets: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 14, paddingVertical: 6, gap: 6 },
  sheet: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  sheetSelected: { backgroundColor: colors.primary },
  sheetText: { color: colors.textSoft, fontSize: 12, fontWeight: "700" },
  sheetTextSelected: { color: colors.white },
  sheetCount: { minWidth: 20, paddingHorizontal: 5, height: 18, borderRadius: 9, backgroundColor: colors.cream, alignItems: "center", justifyContent: "center" },
  sheetCountSelected: { backgroundColor: colors.white },
  sheetCountText: { color: colors.textSoft, fontSize: 10, fontWeight: "800" },
  tri: { flexDirection: "row", borderWidth: 1, borderColor: colors.line, borderRadius: 8, overflow: "hidden", marginTop: 6, backgroundColor: colors.white },
  triItem: { flex: 1, paddingVertical: 6, paddingHorizontal: 4, alignItems: "center", borderRightWidth: 1, borderRightColor: colors.line },
  triInherit: { backgroundColor: colors.cream },
  triYes: { backgroundColor: colors.primary },
  triNo: { backgroundColor: colors.danger },
  triText: { color: colors.textSoft, fontSize: 11, fontWeight: "600" },
  listRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.white },
  listIcon: { width: 30, height: 30, borderRadius: 8, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  group: { backgroundColor: colors.white, borderRadius: 10, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  groupTitle: { color: colors.textSoft, fontSize: 10, fontWeight: "800", letterSpacing: 1, marginBottom: 5, marginLeft: 2 },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center" },
  badgeText: { color: colors.white, fontSize: 10, fontWeight: "800" },
  back: { flexDirection: "row", alignItems: "center", gap: 2, borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.white },
  backText: { color: colors.primary, fontSize: 12, fontWeight: "800" },
});

export function ProductImage({ uri, style }: { uri: string; style: ComponentProps<typeof Image>["style"] }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  if (failed || !uri) {
    return <View style={[style, { backgroundColor: colors.cream, alignItems: "center", justifyContent: "center" }]}>
      <Ionicons name="cube-outline" size={22} color={colors.muted} />
    </View>;
  }
  return <Image source={{ uri }} style={style} onError={() => setFailed(true)} />;
}
