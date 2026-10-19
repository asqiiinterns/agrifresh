import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import { ScreenHeader } from "../ui/components";
import { useNav, type TabDef } from "../ui/navigation";
import { colors, ui } from "../ui/theme";

// "Plus": every section that does not fit in the bottom bar, as large tiles.
export function MoreScreen({ items, badges }: { items: TabDef[]; badges: Partial<Record<string, number>> }) {
  const { navigate } = useNav();
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="TOUTES LES RUBRIQUES" title="Plus" />
    <ScrollView contentContainerStyle={ui.content}>
      <View style={styles.grid}>
        {items.map((item) => {
          const badge = badges[item.key] ?? 0;
          return <Pressable key={item.key} onPress={() => navigate(item.key)} style={({ pressed }) => [styles.tile, pressed && { opacity: 0.7 }]} accessibilityRole="button">
            <View style={styles.icon}>
              <Ionicons name={item.icon} size={24} color={colors.green} />
              {badge > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{badge > 99 ? "99+" : badge}</Text></View> : null}
            </View>
            <Text style={[ui.strong, { marginTop: 10 }]}>{item.label}</Text>
            {item.description ? <Text style={ui.small} numberOfLines={2}>{item.description}</Text> : null}
          </Pressable>;
        })}
      </View>
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 14 },
  tile: { flexBasis: "47%", flexGrow: 1, backgroundColor: colors.white, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: colors.line, minHeight: 120 },
  icon: { width: 44, height: 44, borderRadius: 12, backgroundColor: "#e6efe4", alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: -6, right: -8, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  badgeText: { color: colors.white, fontSize: 10, fontWeight: "800" },
});
