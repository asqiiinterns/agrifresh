import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import qrcode from "qrcode-generator";

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

// One vector shape on a white square with the standard 4-module margin: no seams between the
// modules (small views left thin white lines on some phones and drivers' cameras could not read it).
export function QrCode({ value, size = 240 }: { value: string; size?: number }) {
  const { count, path } = useMemo(() => {
    const qr = matrix(value);
    const total = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < total; row += 1) {
      for (let column = 0; column < total; column += 1) {
        if (!qr.isDark(row, column)) continue;
        // Consecutive dark modules of a row form one rectangle.
        let end = column;
        while (end + 1 < total && qr.isDark(row, end + 1)) end += 1;
        d += `M${column} ${row}h${end - column + 1}v1h-${end - column + 1}z`;
        column = end;
      }
    }
    return { count: total, path: d };
  }, [value]);
  const quiet = 4;
  return <View style={{ width: size, height: size, backgroundColor: "#ffffff", alignSelf: "center" }}>
    <Svg width={size} height={size} viewBox={`${-quiet} ${-quiet} ${count + quiet * 2} ${count + quiet * 2}`}>
      <Path d={path} fill="#000000" />
    </Svg>
  </View>;
}
