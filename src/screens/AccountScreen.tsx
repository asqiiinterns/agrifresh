import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "../ui/Text";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { formatClientNumber, roleLabels, type Account } from "../data/account";
import { Button, Field, ScreenHeader } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { ui } from "../ui/theme";
import { StaffProductsModal } from "./StaffProductsScreen";
import { useCan } from "../data/permissions";
import { fontScales, useDisplay } from "../ui/display";
import { Chip } from "../ui/components";

export function AccountScreen({ session, account }: { session: Session; account: Account | null }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [productsVisible, setProductsVisible] = useState(false);
  // Admins manage products from the Admin tab; other profiles with the right do it here.
  const isStaff = useCan()("products.manage") && account?.role !== "admin";

  async function changePassword() {
    if (!supabase) return;
    if (password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    setBusy(true); setMessage(""); setError("");
    const { error: authError } = await supabase.auth.updateUser({ password });
    if (authError) setError(errorMessage(authError, "Impossible de modifier le mot de passe."));
    else { setMessage("Mot de passe mis à jour."); setPassword(""); }
    setBusy(false);
  }

  async function signOut() {
    if (!supabase) return;
    setBusy(true);
    const { error: authError } = await supabase.auth.signOut();
    if (authError) setError(authError.message);
    setBusy(false);
  }

  const client = account?.client;
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="VOTRE ESPACE AGRIFRESH" title="Mon compte" />
    <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      <View style={ui.card}>
        <Text style={ui.strong}>{session.user.email}</Text>
        <Text style={ui.small}>{account ? roleLabels[account.role] : "Profil en cours de chargement"}</Text>
        {client ? <View style={ui.divider}>
          <Text style={ui.strong}>{client.business_name}</Text>
          <Text style={ui.small}>{formatClientNumber(client.client_number)}{client.contact_name ? ` · ${client.contact_name}` : ""}{client.phone ? ` · ${client.phone}` : ""}</Text>
          {client.delivery_points.map((point) => <Text key={point.id} style={[ui.body, { marginTop: 6 }]}>• {point.label} — {point.address_line}, {point.city}</Text>)}
          <Text style={[ui.small, { marginTop: 8 }]}>Pour modifier ces informations ou ajouter un point de livraison, contactez AgriFresh.</Text>
        </View> : null}
      </View>

      {isStaff ? <View style={ui.card}>
        <Text style={ui.strong}>Catalogue</Text>
        <Text style={ui.small}>Produits, prix, TVA, stock, nouveautés et origine (producteur, région, label).</Text>
        <Button label="GÉRER LES PRODUITS" onPress={() => setProductsVisible(true)} style={{ marginTop: 10 }} />
      </View> : null}



      <DisplaySettingsCard showProducts={account?.role === "customer"} />

      <View style={ui.card}>
        <Text style={ui.strong}>Changer mon mot de passe</Text>
        <Field label="Nouveau mot de passe" value={password} onChangeText={setPassword} secureTextEntry />
        <View style={{ marginTop: 12, gap: 8 }}>
          {message ? <Text style={ui.success}>{message}</Text> : null}
          {error ? <Text style={ui.error}>{error}</Text> : null}
          <Button label="ENREGISTRER" variant="secondary" onPress={() => void changePassword()} busy={busy} />
        </View>
      </View>

      <Button label="SE DÉCONNECTER" onPress={() => void signOut()} busy={busy} style={{ marginTop: 20 }} />
    </ScrollView>
    {isStaff ? <StaffProductsModal visible={productsVisible} onClose={() => setProductsVisible(false)} /> : null}
  </View>;
}

// Display preferences for this device: text size and product list layout.
function DisplaySettingsCard({ showProducts }: { showProducts: boolean }) {
  const display = useDisplay();
  return <View style={ui.card}>
    <Text style={ui.strong}>Affichage</Text>
    <Text style={ui.small}>Réglages de cet appareil uniquement.</Text>
    <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Taille du texte</Text>
    <View style={[ui.wrapRow, { marginTop: 6 }]}>
      {fontScales.map((option) => <Chip key={option.value} label={option.label} selected={display.fontScale === option.value} onPress={() => display.update({ fontScale: option.value })} />)}
    </View>
    <View style={[ui.divider, { marginTop: 10 }]}>
      <Text style={ui.body}>Aperçu : Commande #128 · 12,5 kg d’oranges</Text>
      <Text style={ui.small}>Les textes de toute l’application suivent ce réglage.</Text>
    </View>
    {showProducts ? <>
      <Text style={[ui.fieldLabel, { marginTop: 14 }]}>Liste des produits</Text>
      <View style={[ui.wrapRow, { marginTop: 6 }]}>
        <Chip label="Avec photos" selected={!display.compactProducts} onPress={() => display.update({ compactProducts: false })} />
        <Chip label="Compacte (sans photos)" selected={display.compactProducts} onPress={() => display.update({ compactProducts: true })} />
      </View>
    </> : null}
    <Button label="RÉTABLIR L’AFFICHAGE PAR DÉFAUT" variant="secondary" onPress={display.reset} style={{ marginTop: 14 }} />
  </View>;
}
