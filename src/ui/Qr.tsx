import { useMemo } from "react";
import { View } from "react-native";
import qrcode from "qrcode-generator";
import { colors } from "./theme";

// QR payloads: delivery note, delivery point (wall sticker) and client reception code.
export const QR = {
  deliveryNote: (token: string) => `agrifresh:bl:${token}`,
  point: (token: string) => `agrifresh:point:${token}`,
  client: (token: string) => `agrifresh:client:${token}`,
};

export type ScannedQr = { kind: "bl" | "point" | "client"; token: string };

export function parseQr(data: string): ScannedQr | null {
  const match = data.trim().match(/^agrifresh:(bl|point|client):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? { kind: match[1].toLowerCase() as ScannedQr["kind"], token: match[2].toLowerCase() } : null;
}

function matrix(text: string) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr;
}

export function qrSvg(text: string, cellSize = 6) {
  return matrix(text).createSvgTag({ cellSize, margin: 2, scalable: true });
}

// Drawn with plain views so it works in Expo Go without an SVG library.
export function QrCode({ value, size = 240 }: { value: string; size?: number }) {
  const rows = useMemo(() => {
    const qr = matrix(value);
    const count = qr.getModuleCount();
    return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, column) => qr.isDark(row, column)));
  }, [value]);
  const quiet = 2;
  const cell = Math.floor(size / (rows.length + quiet * 2));
  return <View style={{ padding: cell * quiet, backgroundColor: colors.white, alignSelf: "center" }}>
    {rows.map((row, rowIndex) => <View key={rowIndex} style={{ flexDirection: "row" }}>
      {row.map((dark, columnIndex) => <View key={columnIndex} style={{ width: cell, height: cell, backgroundColor: dark ? "#000" : colors.white }} />)}
    </View>)}
  </View>;
}
