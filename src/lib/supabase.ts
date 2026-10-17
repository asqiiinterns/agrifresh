import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

// Public project values (the publishable key is meant to ship in client apps). Used when the
// build environment is missing them or still holds the .env.example placeholders.
const DEFAULT_URL = "https://esssgjpbhdesnghpusuw.supabase.co";
const DEFAULT_KEY = "sb_publishable_p5gyVqnfr8Ttd80W7TvX-g_zI3MPN6k";

const isPlaceholder = (value: string | undefined) => !value || /your[_-]?(project|supabase)/i.test(value);

const envUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
const envKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
const url = isPlaceholder(envUrl) ? DEFAULT_URL : envUrl;
const key = isPlaceholder(envKey) ? DEFAULT_KEY : envKey;

export const isSupabaseConfigured = Boolean(url && key);

export const supabaseHost = (() => {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return url ?? "";
  }
})();

export const supabase = isSupabaseConfigured
  ? createClient(url!, key!, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;