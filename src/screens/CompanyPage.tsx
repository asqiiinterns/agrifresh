import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
import { company, type CompanyProfile } from "../config/company";
import { loadCompanyProfile, saveCompanyProfile } from "../data/company";
import { Button, Field, Loading, ScreenHeader } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Paramétrage → Entreprise: the seller's details printed on its delivery notes, invoices,
// credit notes, returns and QR sheets, and the colour those documents wear.
export function CompanyPage({ header }: { header: React.ReactNode }) {
  const [profile, setProfile] = useState<CompanyProfile>({ ...company });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadCompanyProfile().then(setProfile).catch(() => undefined).finally(() => setLoading(false));
  }, []);

  const set = (key: keyof CompanyProfile) => (value: string) => setProfile((current) => ({ ...current, [key]: value }));
  const validColor = /^#[0-9a-fA-F]{6}$/.test(profile.brandColor);

  async function save() {
    setError("");
    if (profile.brandColor && !validColor) {
      setError("Couleur invalide : utilisez le format #RRVVBB (par exemple #1F3B63).");
      return;
    }
    try {
      await saveCompanyProfile(profile);
      notify("Entreprise", "Les informations sont enregistrées. Elles apparaissent sur les prochains documents.");
    } catch (cause) {
      setError(errorMessage(cause, "Les informations n’ont pas pu être enregistrées. La migration 20261106 est-elle exécutée ?"));
    }
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="PARAMÉTRAGE" title="Entreprise" right={header} />
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      <Text style={[ui.small, { marginTop: 8 }]}>Ces informations sont imprimées sur vos bons de livraison, factures, avoirs, retours et fiches QR.</Text>
      <View style={ui.card}>
        <Field label="Raison sociale" value={profile.name} onChangeText={set("name")} placeholder="Nom de l’entreprise" />
        <Field label="Slogan (facultatif)" value={profile.tagline} onChangeText={set("tagline")} />
        <Field label="Adresse" value={profile.address} onChangeText={set("address")} multiline />
        <Field label="Téléphone" value={profile.phone} onChangeText={set("phone")} keyboardType="phone-pad" />
        <Field label="E-mail" value={profile.email} onChangeText={set("email")} keyboardType="email-address" autoCapitalize="none" />
        <Field label="Matricule fiscal" value={profile.taxId} onChangeText={set("taxId")} autoCapitalize="characters" />
        <Field label="RIB (règlement par virement)" value={profile.rib} onChangeText={set("rib")} />
      </View>
      <View style={ui.card}>
        <Text style={ui.strong}>Couleur des documents</Text>
        <View style={[ui.row, { marginTop: 4 }]}>
          <View style={{ flex: 1 }}><Field label="Code couleur (#RRVVBB)" value={profile.brandColor} onChangeText={set("brandColor")} autoCapitalize="none" placeholder="#1F3B63" /></View>
          <View style={[styles.swatch, { backgroundColor: validColor ? profile.brandColor : colors.primary }]} />
        </View>
        <Text style={ui.small}>Laissez vide pour le bleu Appro+.</Text>
      </View>
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      <Button label="ENREGISTRER" onPress={() => save()} style={{ marginTop: 14 }} />
    </ScrollView>}
  </View>;
}

const styles = StyleSheet.create({
  swatch: { width: 40, height: 40, borderRadius: 8, borderWidth: 1, borderColor: colors.line, marginTop: 12 },
});
