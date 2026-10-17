import { useEffect, useState } from "react";
import { Modal, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import * as Print from "expo-print";
import { sharePdf, subscribeToDocuments, type PendingDocument } from "../data/pdf";
import { Button, CloseButton, ScreenHeader } from "./components";
import { errorMessage, notify } from "./notify";
import { ui } from "./theme";

// Mounted once in App: shows generated documents (delivery notes, invoices) on screen first;
// printing or sharing is then an explicit choice.
export function DocumentViewerHost() {
  const [document, setDocument] = useState<PendingDocument | null>(null);
  const [busy, setBusy] = useState<"print" | "share" | null>(null);

  useEffect(() => subscribeToDocuments(setDocument), []);

  async function run(kind: "print" | "share") {
    if (!document) return;
    setBusy(kind);
    try {
      if (kind === "print") await Print.printAsync({ html: document.html });
      else await sharePdf(document);
    } catch (cause) {
      notify(document.title, errorMessage(cause, "L’opération a échoué."));
    } finally {
      setBusy(null);
    }
  }

  // A fixed layout width lets the WebView zoom the A4-like page to the screen.
  const html = document?.html.replace("<head>", `<head><meta name="viewport" content="width=820" />`) ?? "";

  return <Modal visible={document !== null} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setDocument(null)}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="APERÇU" title={document?.title ?? ""} right={<CloseButton onPress={() => setDocument(null)} />} />
      {document ? <WebView originWhitelist={["*"]} source={{ html }} style={{ flex: 1 }} scalesPageToFit setBuiltInZoomControls setDisplayZoomControls={false} /> : null}
      <View style={[ui.row, { padding: 12, gap: 10 }]}>
        <Button label="IMPRIMER / PDF" onPress={() => void run("print")} busy={busy === "print"} disabled={busy !== null} style={{ flex: 1 }} />
        <Button label="PARTAGER" variant="secondary" onPress={() => void run("share")} busy={busy === "share"} disabled={busy !== null} style={{ flex: 1 }} />
      </View>
    </SafeAreaView>
  </Modal>;
}
