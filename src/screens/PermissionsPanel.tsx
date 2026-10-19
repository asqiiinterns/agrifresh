import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import type { Role } from "../data/account";
import { configurableRoles, featureCatalog, fetchRolePermissions, setRolePermission, type Feature } from "../data/permissions";
import { Chip, Loading } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Admin switches (yes/no) for what each profile may use; admins always keep every right.
export function PermissionsPanel() {
  const [role, setRole] = useState<Role>("supervisor");
  const [allowed, setAllowed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    void fetchRolePermissions()
      .then((rows) => setAllowed(Object.fromEntries(rows.map((row) => [`${row.role}|${row.feature}`, row.allowed]))))
      .catch((cause: unknown) => setError(errorMessage(cause, "Impossible de charger les droits.")))
      .finally(() => setLoading(false));
  }, []);

  async function toggle(feature: Feature, value: boolean) {
    const key = `${role}|${feature}`;
    setAllowed((current) => ({ ...current, [key]: value }));
    setSaving(key);
    setError("");
    try {
      await setRolePermission(role, feature, value);
    } catch (cause) {
      setAllowed((current) => ({ ...current, [key]: !value }));
      setError(errorMessage(cause, "Le droit n’a pas pu être enregistré."));
    } finally {
      setSaving(null);
    }
  }

  const audience = configurableRoles.find((item) => item.role === role)?.audience ?? "team";

  return <View style={ui.card}>
    <Text style={ui.strong}>Droits par profil</Text>
    <Text style={ui.small}>Activez ou désactivez chaque fonctionnalité. Les changements s’appliquent à la prochaine ouverture de l’application. L’administrateur garde toujours tous les droits.</Text>
    <View style={[ui.wrapRow, { marginTop: 10 }]}>
      {configurableRoles.map((item) => <Chip key={item.role} label={item.label} selected={role === item.role} onPress={() => setRole(item.role)} />)}
    </View>
    {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
    {loading ? <Loading /> : featureCatalog.filter((group) => group.audience === audience).map((group) => <View key={group.group} style={{ marginTop: 12 }}>
      <Text style={[ui.small, { fontWeight: "800", color: "#405447", letterSpacing: 0.4 }]}>{group.group.toLocaleUpperCase("fr")}</Text>
      {group.items.map((item) => {
        const key = `${role}|${item.key}`;
        return <View key={item.key} style={[ui.row, { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.line }]}>
          <Text style={[ui.body, { flex: 1 }]}>{item.label}</Text>
          <Switch value={allowed[key] ?? false} onValueChange={(value) => void toggle(item.key, value)} disabled={saving === key} trackColor={{ true: colors.green, false: colors.line }} />
        </View>;
      })}
    </View>)}
  </View>;
}
