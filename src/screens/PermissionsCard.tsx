import { useEffect, useState } from "react";
import { Linking, Platform, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as Notifications from "expo-notifications";
import { AudioModule } from "expo-audio";
import { Camera } from "expo-camera";
import { Text } from "../ui/Text";
import { Button } from "../ui/components";
import { registerForPush } from "../notifications";
import { colors, ui } from "../ui/theme";

type State = "granted" | "denied" | "blocked" | "undetermined";
type Access = { key: string; label: string; use: string; icon: React.ComponentProps<typeof Ionicons>["name"]; get: () => Promise<{ granted: boolean; canAskAgain: boolean; status: string }>; ask: () => Promise<unknown> };

const accesses: Access[] = [
  { key: "camera", label: "Appareil photo", use: "Scanner les QR codes de livraison, joindre une photo.", icon: "camera-outline",
    get: () => Camera.getCameraPermissionsAsync(), ask: () => Camera.requestCameraPermissionsAsync() },
  { key: "photos", label: "Photos et vidéos", use: "Joindre une image de la galerie à un message.", icon: "images-outline",
    get: () => ImagePicker.getMediaLibraryPermissionsAsync(), ask: () => ImagePicker.requestMediaLibraryPermissionsAsync() },
  { key: "micro", label: "Micro", use: "Enregistrer un message vocal.", icon: "mic-outline",
    get: () => AudioModule.getRecordingPermissionsAsync(), ask: () => AudioModule.requestRecordingPermissionsAsync() },
  { key: "notifications", label: "Notifications", use: "Recevoir les alertes sur l’écran de verrouillage.", icon: "notifications-outline",
    get: () => Notifications.getPermissionsAsync(), ask: () => registerForPush(true) },
];

const labels: Record<State, { text: string; color: string }> = {
  granted: { text: "Autorisé", color: colors.green },
  denied: { text: "Refusé", color: colors.amber },
  blocked: { text: "Bloqué (réglages)", color: colors.danger },
  undetermined: { text: "Jamais demandé", color: colors.muted },
};

// Plus → Autorisations: the app works without them; each one is only asked for when needed.
export function PermissionsCard() {
  const [states, setStates] = useState<Record<string, State>>({});

  async function refresh() {
    const entries = await Promise.all(accesses.map(async (access) => {
      try {
        const result = await access.get();
        const state: State = result.granted ? "granted" : result.status === "undetermined" ? "undetermined" : result.canAskAgain ? "denied" : "blocked";
        return [access.key, state] as const;
      } catch {
        return [access.key, "undetermined"] as const;
      }
    }));
    setStates(Object.fromEntries(entries));
  }

  useEffect(() => { void refresh(); }, []);

  if (Platform.OS === "web") {
    return <View style={ui.card}>
      <Text style={ui.strong}>Autorisations</Text>
      <Text style={ui.small}>Sur le web, le navigateur demande l’accès à la caméra ou au micro au moment où vous en avez besoin. Vous pouvez le modifier dans les réglages du site de votre navigateur.</Text>
    </View>;
  }

  return <View style={ui.card}>
    <Text style={ui.strong}>Autorisations</Text>
    <Text style={ui.small}>AgriFresh fonctionne sans ces accès. Chacun n’est demandé qu’au moment où vous utilisez la fonction ; vous pouvez les accorder ou les retirer ici.</Text>
    {accesses.map((access) => {
      const state = states[access.key] ?? "undetermined";
      return <View key={access.key} style={[ui.row, ui.divider]}>
        <Ionicons name={access.icon} size={20} color={colors.green} />
        <View style={{ flex: 1 }}>
          <Text style={ui.body}>{access.label} · <Text style={{ color: labels[state].color, fontWeight: "800" }}>{labels[state].text}</Text></Text>
          <Text style={ui.small}>{access.use}</Text>
        </View>
        {state === "granted" || state === "blocked"
          ? <Button label="RÉGLAGES" variant="secondary" onPress={() => void Linking.openSettings()} />
          : <Button label="AUTORISER" variant="secondary" onPress={() => void access.ask().finally(() => void refresh())} />}
      </View>;
    })}
  </View>;
}
