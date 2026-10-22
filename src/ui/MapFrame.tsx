import { WebView } from "react-native-webview";
import { mapEmbedUrl } from "./mapUrl";

// A map shown inside the app (OpenStreetMap, no key needed), with a marker on the position.
export function MapFrame({ latitude, longitude, height = 260 }: { latitude: number; longitude: number; height?: number }) {
  return <WebView source={{ uri: mapEmbedUrl(latitude, longitude) }} style={{ height, borderRadius: 10 }} />;
}
