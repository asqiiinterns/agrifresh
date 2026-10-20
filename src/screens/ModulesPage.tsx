import { useContext, useState } from "react";
import { ScrollView, StyleSheet, Switch, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import { allModules, essentialModules, isModuleOn, moduleGroups, ModulesContext, setModule, type ModuleKey } from "../data/modules";
import { Button, ListGroup, ScreenHeader } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Paramétrage → Modules: switch each function of the app on or off for everyone.
// What is off is not greyed out: it disappears (menus, home, buttons, settings).
export function ModulesPage({ header }: { header: React.ReactNode }) {
  const state = useContext(ModulesContext);
  const [busy, setBusy] = useState<ModuleKey | "all" | null>(null);
  const [error, setError] = useState("");
  const offCount = allModules.filter((item) => state[item.key] === false).length;

  async function toggle(key: ModuleKey, enabled: boolean) {
    setBusy(key);
    setError("");
    try {
      await setModule(key, enabled);
    } catch (cause) {
      setError(errorMessage(cause, "Le module n’a pas pu être modifié. La migration 20261107 est-elle exécutée ?"));
    } finally {
      setBusy(null);
    }
  }

  function applyPreset(keep: ModuleKey[] | null) {
    notify(keep ? "Mode essentiel" : "Tout activer", keep
      ? "Seuls les modules essentiels resteront visibles : livraisons, facturation et messages avec les clients. Les données des autres modules sont conservées."
      : "Tous les modules redeviennent visibles pour les comptes qui en ont le droit.", [
      { text: "Annuler", style: "cancel" },
      { text: "Confirmer", onPress: () => {
        void (async () => {
          setBusy("all");
          setError("");
          try {
            for (const item of allModules) {
              const enabled = keep ? keep.includes(item.key) : true;
              if ((state[item.key] !== false) !== enabled) await setModule(item.key, enabled);
            }
          } catch (cause) {
            setError(errorMessage(cause, "Les modules n’ont pas pu être modifiés."));
          } finally {
            setBusy(null);
          }
        })();
      } },
    ]);
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="PARAMÉTRAGE" title="Modules" subtitle={offCount ? `${offCount} module(s) masqué(s)` : "Tous les modules sont actifs"} right={header} />
    <ScrollView contentContainerStyle={ui.content}>
      <Text style={[ui.small, { marginTop: 8 }]}>Un module désactivé disparaît pour tout le monde : menus, accueil, boutons et réglages. Ses données sont conservées et réapparaissent quand vous le réactivez. Les droits de chaque profil s’appliquent ensuite aux modules actifs.</Text>
      <View style={[ui.wrapRow, { marginTop: 10 }]}>
        <Button label="MODE ESSENTIEL" variant="secondary" busy={busy === "all"} onPress={() => applyPreset(essentialModules)} />
        <Button label="TOUT ACTIVER" variant="secondary" busy={busy === "all"} onPress={() => applyPreset(null)} />
      </View>
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      {moduleGroups.map((group) => <ListGroup key={group.title} title={group.title}>
        {group.modules.map((item) => {
          const on = state[item.key] !== false;
          const blocked = on && !isModuleOn(state, item.key);
          const parents = (item.requires ?? []).map((key) => allModules.find((other) => other.key === key)?.label).filter(Boolean).join(", ");
          return <View key={item.key} style={[styles.row, item.requires && styles.child]}>
            <Ionicons name={item.icon} size={18} color={on && !blocked ? colors.primary : colors.muted} />
            <View style={{ flex: 1 }}>
              <Text style={[ui.strong, !on && { color: colors.muted }]}>{item.label}</Text>
              <Text style={ui.small}>{item.description}</Text>
              {blocked ? <Text style={[ui.small, { color: colors.amber }]}>Masqué tant que « {parents} » est désactivé.</Text> : null}
            </View>
            <Switch value={on} disabled={busy !== null} onValueChange={(value) => void toggle(item.key, value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
          </View>;
        })}
      </ListGroup>)}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.white },
  child: { paddingLeft: 30 },
});
