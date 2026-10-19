import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { supabase } from "./lib/supabase";

export type PushStatus = "registered" | "denied" | "unavailable";

// Alerts received while the app is open are shown as banners too.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
});

let currentToken: string | null = null;

// Asks for permission, then registers this phone so alerts reach its lock screen.
// Not available on the web, nor in Expo Go on Android (push needs the APK and Firebase).
export async function registerForPush(askPermission: boolean): Promise<PushStatus> {
  if (Platform.OS === "web" || !supabase) return "unavailable";
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("alerts", {
        name: "Alertes AgriFresh",
        importance: Notifications.AndroidImportance.HIGH,
        lightColor: "#24543B",
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted" && askPermission) status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return "denied";
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    const { error } = await supabase.rpc("register_push_token", { p_token: token, p_platform: Platform.OS });
    if (error) throw error;
    currentToken = token;
    return "registered";
  } catch {
    return "unavailable";
  }
}

// On sign-out the phone stops receiving this account's alerts.
export async function unregisterPush(): Promise<void> {
  if (!currentToken || !supabase) return;
  await supabase.rpc("unregister_push_token", { p_token: currentToken });
  currentToken = null;
}

export const hasPushToken = () => currentToken !== null;

// Fallback when push is not available (Expo Go, web): a local notification for an alert
// received in real time while the app runs.
export type AlertData = { event?: string; order_id?: string | null; id?: string };

export async function showLocalAlert(title: string, body: string, data?: AlertData): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await Notifications.scheduleNotificationAsync({ content: { title, body, sound: "default", data: data ?? {} }, trigger: null });
  } catch {
    // Local banners are best effort.
  }
}

// The tapped notification carries its event and order, so the app can open the right screen.
export function onAlertTapped(handler: (data: AlertData) => void) {
  if (Platform.OS === "web") return () => {};
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => handler((response.notification.request.content.data ?? {}) as AlertData));
  // A tap that launched the app (it was closed) is delivered once at start-up.
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) handler((response.notification.request.content.data ?? {}) as AlertData);
  }).catch(() => {});
  return () => subscription.remove();
}
