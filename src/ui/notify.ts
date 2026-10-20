import { Alert, Platform } from "react-native";
import { supabaseHost } from "../lib/supabase";
import { tr } from "./i18n";

export type NotifyButton = { text: string; style?: "cancel" | "default" | "destructive"; onPress?: () => void };
export type PendingDialog = { title: string; message: string; buttons: NotifyButton[] };

// On the web, dialogs are drawn by the app (DialogHost): browser alert/confirm would freeze the page.
let dialogListener: ((dialog: PendingDialog) => void) | null = null;
export function subscribeToDialogs(listener: (dialog: PendingDialog) => void) {
  dialogListener = listener;
  return () => { if (dialogListener === listener) dialogListener = null; };
}

export function notify(title: string, message = "", buttons?: NotifyButton[]) {
  const translated = (buttons ?? [{ text: "OK" }]).map((button) => ({ ...button, text: tr(button.text) }));
  if (Platform.OS !== "web") {
    Alert.alert(tr(title), tr(message), translated);
    return;
  }
  if (dialogListener) {
    dialogListener({ title: tr(title), message: tr(message), buttons: translated });
    return;
  }
  if (typeof window !== "undefined") window.alert(message ? `${tr(title)}\n\n${tr(message)}` : tr(title));
}

export function errorMessage(cause: unknown, fallback: string) {
  const message = cause instanceof Error ? cause.message : typeof cause === "object" && cause && "message" in cause ? String((cause as { message: unknown }).message) : fallback;
  // Browsers and React Native report unreachable servers with these generic messages.
  if (/failed to fetch|network request failed|load failed|networkerror/i.test(message)) {
    return `Impossible de joindre le serveur (${supabaseHost || "adresse non configurée"}). Vérifiez votre connexion internet puis réessayez.`;
  }
  return message;
}
