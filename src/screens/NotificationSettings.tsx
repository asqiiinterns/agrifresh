import { useEffect, useState } from "react";
import { Platform, Switch, View } from "react-native";
import { Text, TextInput } from "../ui/Text";
import { fetchEmailStatus, fetchMyNotificationPrefs, fetchNotificationSettings, sendTestEmail, setEmailApiKey, setEmailSettings, setMyNotificationPrefs, setNotificationSetting, type EmailStatus, type NotificationSetting } from "../data/alerts";
import { registerForPush, type PushStatus } from "../notifications";
import { Button, Field, Loading } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

const pushStatusText: Record<PushStatus, string> = {
  registered: "Ce téléphone reçoit les notifications sur l’écran de verrouillage.",
  denied: "Les notifications sont refusées pour Appro+ dans les réglages du téléphone.",
  unavailable: Platform.OS === "web"
    ? "Sur le web, les notifications s’affichent dans l’onglet Notifications."
    : "Notifications d’écran de verrouillage indisponibles ici (Expo Go ou configuration en attente) : les notifications restent dans l’onglet Notifications.",
};

// Compte → Notifications: each person chooses push and e-mail for their own account.
export function MyNotificationsCard() {
  const [prefs, setPrefs] = useState<{ push: boolean; email: boolean } | null>(null);
  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchMyNotificationPrefs().then(setPrefs).catch(() => setPrefs({ push: true, email: true }));
    void registerForPush(false).then(setPushStatus);
  }, []);

  async function save(next: { push: boolean; email: boolean }) {
    setPrefs(next);
    try {
      await setMyNotificationPrefs(next.push, next.email);
    } catch (cause) {
      notify("Notifications", errorMessage(cause, "Le réglage n’a pas pu être enregistré."));
    }
  }

  async function enable() {
    setBusy(true);
    setPushStatus(await registerForPush(true));
    setBusy(false);
  }

  return <View style={ui.card}>
    <Text style={ui.strong}>Notifications</Text>
    {!prefs ? <Loading /> : <>
      <View style={[ui.row, { justifyContent: "flex-start", marginTop: 10 }]}>
        <Switch value={prefs.push} onValueChange={(value) => void save({ ...prefs, push: value })} trackColor={{ true: colors.primary, false: colors.line }} />
        <View style={{ flex: 1 }}><Text style={ui.body}>Notifications sur le téléphone</Text><Text style={ui.small}>Notifications affichées sur l’écran de verrouillage.</Text></View>
      </View>
      <View style={[ui.row, { justifyContent: "flex-start", marginTop: 10 }]}>
        <Switch value={prefs.email} onValueChange={(value) => void save({ ...prefs, email: value })} trackColor={{ true: colors.primary, false: colors.line }} />
        <View style={{ flex: 1 }}><Text style={ui.body}>E-mails</Text><Text style={ui.small}>Pour les notifications envoyées aussi par e-mail.</Text></View>
      </View>
      {pushStatus ? <Text style={[ui.small, { marginTop: 10, color: pushStatus === "registered" ? colors.primary : colors.amber }]}>{pushStatusText[pushStatus]}</Text> : null}
      {pushStatus === "denied" && Platform.OS !== "web" ? <Button label="AUTORISER LES NOTIFICATIONS" variant="secondary" onPress={() => enable()} busy={busy} style={{ marginTop: 10 }} /> : null}
    </>}
  </View>;
}

// Admin → Alertes et e-mails: which events notify, and the e-mail service.
export function AlertSettingsPanel() {
  const [settings, setSettings] = useState<NotificationSetting[]>([]);
  const [email, setEmail] = useState<EmailStatus | null>(null);
  const [from, setFrom] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function reload() {
    try {
      const [nextSettings, nextEmail] = await Promise.all([fetchNotificationSettings(), fetchEmailStatus()]);
      setSettings(nextSettings);
      setEmail(nextEmail);
      setFrom(nextEmail.from);
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les réglages."));
    }
  }

  useEffect(() => { void reload(); }, []);

  async function run(key: string, task: () => Promise<void>, done?: string) {
    setBusy(key);
    setError("");
    try {
      await task();
      await reload();
      if (done) notify("Notifications et e-mails", done);
    } catch (cause) {
      setError(errorMessage(cause, "L’enregistrement a échoué."));
    } finally {
      setBusy(null);
    }
  }

  if (!email) return error ? <Text style={ui.error}>{error}</Text> : <Loading />;

  return <>
    <View style={ui.card}>
      <Text style={ui.strong}>Notifications par événement</Text>
      <Text style={ui.small}>Chaque notification apparaît toujours dans l’onglet Notifications. Choisissez si elle est aussi envoyée sur l’écran de verrouillage du téléphone et par e-mail.</Text>
      <View style={[ui.row, { marginTop: 10 }]}>
        <Text style={[ui.small, { flex: 1, fontWeight: "800" }]}>ÉVÉNEMENT</Text>
        <Text style={[ui.small, { width: 64, textAlign: "center", fontWeight: "800" }]}>NOTIF.</Text>
        <Text style={[ui.small, { width: 64, textAlign: "center", fontWeight: "800" }]}>E-MAIL</Text>
      </View>
      {settings.map((setting) => <View key={setting.event} style={[ui.row, ui.divider, { marginTop: 6, paddingTop: 6 }]}>
        <View style={{ flex: 1 }}><Text style={ui.body}>{setting.label}</Text><Text style={ui.small}>{setting.audience}</Text></View>
        <View style={{ width: 64, alignItems: "center" }}><Switch value={setting.push_enabled} onValueChange={(value) => void run(setting.event, () => setNotificationSetting(setting.event, value, setting.email_enabled))} trackColor={{ true: colors.primary, false: colors.line }} /></View>
        <View style={{ width: 64, alignItems: "center" }}><Switch value={setting.email_enabled} onValueChange={(value) => void run(setting.event, () => setNotificationSetting(setting.event, setting.push_enabled, value))} trackColor={{ true: colors.primary, false: colors.line }} /></View>
      </View>)}
    </View>

    <View style={ui.card}>
      <Text style={ui.strong}>Envoi des e-mails</Text>
      <Text style={ui.small}>Service Resend (resend.com) : créez une clé API, puis vérifiez votre domaine pour écrire à tous vos clients. Sans domaine vérifié, Resend n’envoie qu’à l’adresse du compte Resend.</Text>
      <View style={[ui.row, { justifyContent: "flex-start", marginTop: 12 }]}>
        <Switch value={email.enabled} onValueChange={(value) => void run("enabled", () => setEmailSettings(value, from || email.from))} trackColor={{ true: colors.primary, false: colors.line }} />
        <Text style={[ui.body, { flex: 1 }]}>Activer l’envoi d’e-mails</Text>
      </View>
      <Field label="Expéditeur (ex. Ma Société <commandes@votre-domaine.tn>)" value={from} onChangeText={setFrom} autoCapitalize="none" />
      <Button label="ENREGISTRER L’EXPÉDITEUR" variant="secondary" onPress={() => run("from", () => setEmailSettings(email.enabled, from), "Expéditeur enregistré.")} busy={busy === "from"} style={{ marginTop: 8 }} />
      <Text style={[ui.small, { marginTop: 12, color: email.has_key ? colors.primary : colors.amber }]}>{email.has_key ? "Clé API enregistrée (masquée)." : "Aucune clé API enregistrée."}</Text>
      <View style={ui.field}>
        <Text style={ui.fieldLabel}>{email.has_key ? "Remplacer la clé API" : "Clé API Resend"}</Text>
        <TextInput value={apiKey} onChangeText={setApiKey} placeholder="re_…" placeholderTextColor={colors.muted} style={ui.input} autoCapitalize="none" autoCorrect={false} secureTextEntry />
      </View>
      <Button label="ENREGISTRER LA CLÉ" variant="secondary" onPress={() => run("key", async () => { await setEmailApiKey(apiKey); setApiKey(""); }, "Clé enregistrée dans le coffre sécurisé.")} busy={busy === "key"} disabled={!apiKey.trim()} style={{ marginTop: 8 }} />
      <Field label="Envoyer un e-mail de test à" value={testTo} onChangeText={setTestTo} keyboardType="email-address" autoCapitalize="none" />
      <Button label="ENVOYER UN TEST" variant="secondary" onPress={() => run("test", () => sendTestEmail(testTo), "E-mail de test envoyé : vérifiez la boîte de réception (et les indésirables).")} busy={busy === "test"} disabled={!testTo.trim()} style={{ marginTop: 8 }} />
      {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
    </View>
  </>;
}
