import { WebView } from "react-native-webview";

// Native preview; a fixed layout width lets the WebView zoom the A4-like page to the screen.
export function DocumentFrame({ html }: { html: string }) {
  const source = html.replace("<head>", `<head><meta name="viewport" content="width=820" />`);
  return <WebView originWhitelist={["*"]} source={{ html: source }} style={{ flex: 1 }} scalesPageToFit setBuiltInZoomControls setDisplayZoomControls={false} />;
}
