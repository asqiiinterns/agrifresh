import { Alert, Platform } from "react-native";
import { supabaseHost } from "../lib/supabase";

export type NotifyButton = { text: string; style?: "cancel" | "default" | "destructive"; onPress?: () => void };

// React Native Web's Alert is a no-op, so fall back to the browser dialogs.
export function notify(title: string, message = "", buttons?: NotifyButton[]) {
  if (Platform.OS !== "web") {
    Alert.alert(title, message, buttons);
    return;
  }
  if (typeof window === "undefined") return;
  const text = message ? `${title}\n\n${message}` : title;
  const action = buttons?.find((button) => button.style !== "cancel");
  if (buttons && buttons.length > 1) {
    if (window.confirm(text)) action?.onPress?.();
  } else {
    window.alert(text);
    action?.onPress?.();
  }
}

export function errorMessage(cause: unknown, fallback: string) {
  const message = cause instanceof Error ? cause.message : typeof cause === "object" && cause && "message" in cause ? String((cause as { message: unknown }).message) : fallback;
  // Browsers and React Native report unreachable servers with these generic messages.
  if (/failed to fetch|network request failed|load failed|networkerror/i.test(message)) {
    return `Impossible de joindre le serveur (${supabaseHost || "adresse non configurée"}). Vérifiez votre connexion internet puis réessayez.`;
  }
  return message;
}
