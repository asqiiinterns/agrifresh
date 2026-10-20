import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Switch, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import {
  allModules, essentialModules, fetchModuleDefaults, fetchOrgModules, moduleGroups, setModule, setOrgModule, setPlanModule,
  type ModuleDef, type ModuleKey, type ModuleState, type OrgModules,
} from "../data/modules";
import { Button, Chip, ListGroup, Loading, ScreenHeader } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Three uses of the same list of modules:
//   platform  Appro+ → Paramétrage → Modules: the default of each module for every Pro;
//   plan      Appro+ → a Pro → Modules: what this Pro's plan includes or excludes;
//   org       a Pro's Paramétrage → Modules: its Responsable switches on or off what its plan includes.
// What is off is not greyed out: it disappears (menus, home, buttons, settings).
export type ModulesMode = { kind: "platform" } | { kind: "org" } | { kind: "plan"; orgId: string; orgName: string };

export function ModulesPage({ header, mode = { kind: "org" } }: { header: React.ReactNode; mode?: ModulesMode }) {
  const [defaults, setDefaults] = useState<ModuleState>({});
  const [org, setOrg] = useState<OrgModules | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ModuleKey | "all" | null>(null);
  const [error, setError] = useState("");
  const orgId = mode.kind === "plan" ? mode.orgId : undefined;

  async function reload() {
    try {
      if (mode.kind === "platform") setDefaults(await fetchModuleDefaults());
      else {
        const next = await fetchOrgModules(orgId);
        if (!next) setError("Exécutez la migration 20261118_pro_modules_pricing.sql pour gérer les modules par Pro.");
        setOrg(next);
      }
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les modules."));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void reload(); }, [mode.kind, orgId]);

  // On for this page: the default (platform), the plan (plan) or the Pro's switch within its plan (org).
  const isOn = (key: ModuleKey): boolean => {
    if (mode.kind === "platform") return defaults[key] !== false;
    const entry = org?.[key];
    if (!entry) return true;
    return mode.kind === "plan" ? entry.included : entry.included && entry.enabled;
  };
  // A module is also hidden while a module it relies on is off.
  const parentsOff = (item: ModuleDef) => (item.requires ?? []).filter((parent) => !isOn(parent));

  async function run(key: ModuleKey | "all", action: () => Promise<void>) {
    setBusy(key);
    setError("");
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(errorMessage(cause, "Le module n’a pas pu être modifié."));
    } finally {
      setBusy(null);
    }
  }

  const toggle = (key: ModuleKey, enabled: boolean) => run(key, () => mode.kind === "platform" ? setModule(key, enabled) : setOrgModule(key, enabled));
  const setPlan = (key: ModuleKey, granted: boolean | null) => mode.kind === "plan" ? run(key, () => setPlanModule(mode.orgId, key, granted)) : undefined;

  function applyPreset(label: string, body: string, valueOf: (key: ModuleKey) => boolean | null) {
    notify(label, body, [
      { text: "Annuler", style: "cancel" },
      { text: "Confirmer", onPress: () => {
        void run("all", async () => {
          for (const item of allModules) {
            const value = valueOf(item.key);
            if (mode.kind === "plan") {
              if ((org?.[item.key]?.granted ?? null) !== value) await setPlanModule(mode.orgId, item.key, value);
            } else if (isOn(item.key) !== value) {
              if (mode.kind === "platform") await setModule(item.key, !!value);
              else if (!value || org?.[item.key]?.included) await setOrgModule(item.key, !!value);
            }
          }
        });
      } },
    ]);
  }

  const offCount = allModules.filter((item) => !isOn(item.key)).length;
  const title = mode.kind === "plan" ? `Formule · ${mode.orgName}` : mode.kind === "platform" ? "Modules par défaut" : "Modules";
  const intro = mode.kind === "platform"
    ? "La valeur par défaut de chaque module pour tous les Pros. Un Pro peut ensuite avoir une formule qui inclut ou exclut un module (Pros → fiche du Pro → Modules)."
    : mode.kind === "plan"
      ? "Ce que la formule de ce Pro inclut. « Par défaut » suit le réglage d’Appro+ pour tous les Pros. Le Responsable du Pro active ensuite, ou non, chaque module inclus."
      : "Un module désactivé disparaît pour votre équipe et vos clients : menus, accueil, boutons et réglages. Ses données sont conservées. Les modules non inclus dans votre formule se demandent à l’équipe Appro+.";

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={mode.kind === "org" ? "PARAMÉTRAGE" : "APPRO+"} title={title} subtitle={loading ? undefined : offCount ? `${offCount} module(s) masqué(s)` : "Tous les modules sont actifs"} right={header} />
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content}>
      <Text style={[ui.small, { marginTop: 8 }]}>{intro}</Text>
      <View style={[ui.wrapRow, { marginTop: 10 }]}>
        {mode.kind === "plan" ? <>
          <Button label="FORMULE ESSENTIEL" variant="secondary" busy={busy === "all"} onPress={() => applyPreset("Formule Essentiel", "La formule n’inclura que les livraisons, la facturation et les messages avec les clients.", (key) => essentialModules.includes(key))} />
          <Button label="TOUT INCLURE" variant="secondary" busy={busy === "all"} onPress={() => applyPreset("Tout inclure", "Tous les modules seront inclus dans la formule de ce Pro.", () => true)} />
          <Button label="PAR DÉFAUT" variant="secondary" busy={busy === "all"} onPress={() => applyPreset("Revenir aux valeurs par défaut", "Chaque module suivra de nouveau le réglage d’Appro+ pour tous les Pros.", () => null)} />
        </> : <>
          <Button label="MODE ESSENTIEL" variant="secondary" busy={busy === "all"} onPress={() => applyPreset("Mode essentiel", "Seuls les modules essentiels resteront visibles : livraisons, facturation et messages avec les clients. Les données des autres modules sont conservées.", (key) => essentialModules.includes(key))} />
          <Button label="TOUT ACTIVER" variant="secondary" busy={busy === "all"} onPress={() => applyPreset("Tout activer", mode.kind === "org" ? "Tous les modules de votre formule redeviennent visibles pour les comptes qui en ont le droit." : "Tous les modules redeviennent actifs par défaut.", () => true)} />
        </>}
      </View>
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      {moduleGroups.map((group) => <ListGroup key={group.title} title={group.title}>
        {group.modules.map((item) => {
          const on = isOn(item.key);
          const entry = org?.[item.key];
          const locked = mode.kind === "org" && entry ? !entry.included : false;
          const blocked = on && parentsOff(item).length > 0;
          const parents = parentsOff(item).map((key) => allModules.find((other) => other.key === key)?.label).filter(Boolean).join(", ");
          return <View key={item.key} style={[styles.row, item.requires && styles.child]}>
            <Ionicons name={locked ? "lock-closed-outline" : item.icon} size={18} color={on && !blocked ? colors.primary : colors.muted} />
            <View style={{ flex: 1 }}>
              <Text style={[ui.strong, !on && { color: colors.muted }]}>{item.label}</Text>
              <Text style={ui.small}>{item.description}</Text>
              {locked ? <Text style={[ui.small, { color: colors.amber }]}>Non inclus dans votre formule : contactez l’équipe Appro+.</Text> : null}
              {blocked ? <Text style={[ui.small, { color: colors.amber }]}>Masqué tant que « {parents} » est désactivé.</Text> : null}
              {mode.kind === "plan" && entry && entry.included && !entry.enabled ? <Text style={[ui.small, { color: colors.amber }]}>Désactivé par le Pro.</Text> : null}
              {mode.kind === "plan" ? <View style={[ui.wrapRow, { marginTop: 6 }]}>
                <Chip label={`Par défaut (${entry?.default === false ? "non" : "oui"})`} selected={(entry?.granted ?? null) === null} onPress={() => void setPlan(item.key, null)} />
                <Chip label="Inclus" selected={entry?.granted === true} onPress={() => void setPlan(item.key, true)} />
                <Chip label="Exclu" selected={entry?.granted === false} onPress={() => void setPlan(item.key, false)} />
              </View> : null}
            </View>
            {mode.kind !== "plan" ? <Switch value={on} disabled={busy !== null || locked} onValueChange={(value) => void toggle(item.key, value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} /> : null}
          </View>;
        })}
      </ListGroup>)}
    </ScrollView>}
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.white },
  child: { paddingLeft: 30 },
});
