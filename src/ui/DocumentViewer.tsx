import { useEffect, useState } from "react";
import { Modal, Platform, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Print from "expo-print";
import { sharePdf, subscribeToDocuments, type PendingDocument } from "../data/pdf";
import { downloadPdf } from "../data/pdfDownload";
import { Button, CloseButton, ScreenHeader } from "./components";
import { DocumentFrame } from "./DocumentFrame";
import { errorMessage, notify } from "./notify";
import { ui } from "./theme";

type Action = "download" | "print" | "share";

// Mounted once in App: every generated document (delivery note, invoice, QR stickers)
// opens here first; downloading, printing or sharing is then an explicit choice.
export function DocumentViewerHost() {
  const [document, setDocument] = useState<PendingDocument | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);

  useEffect(() => subscribeToDocuments(setDocument), []);

  async function run(action: Action) {
    if (!document) return;
    setBusy(action);
    try {
      if (action === "download") await downloadPdf(document.html, document.fileName);
      else if (action === "print") await Print.printAsync({ html: document.html });
      else await sharePdf(document);
    } catch (cause) {
      notify(document.title, errorMessage(cause, "L’opération a échoué."));
    } finally {
      setBusy(null);
    }
  }

  const web = Platform.OS === "web";
  return <Modal visible={document !== null} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setDocument(null)}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="APERÇU" title={document?.title ?? ""} right={<CloseButton onPress={() => setDocument(null)} />} />
      <View style={{ flex: 1 }}>{document ? <DocumentFrame html={document.html} /> : null}</View>
      <View style={[ui.row, { padding: 12, gap: 10 }]}>
        <Button label={web ? "TÉLÉCHARGER LE PDF" : "IMPRIMER / PDF"} onPress={() => void run(web ? "download" : "print")} busy={busy === (web ? "download" : "print")} disabled={busy !== null} style={{ flex: 1 }} />
        <Button label={web ? "IMPRIMER" : "PARTAGER"} variant="secondary" onPress={() => void run(web ? "print" : "share")} busy={busy === (web ? "print" : "share")} disabled={busy !== null} style={{ flex: 1 }} />
      </View>
    </SafeAreaView>
  </Modal>;
}
