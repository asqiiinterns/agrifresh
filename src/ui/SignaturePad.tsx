import { useRef, useState } from "react";
import { Modal, PanResponder, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { Text } from "./Text";
import { Button, CloseButton, Field, ScreenHeader } from "./components";
import { colors, ui } from "./theme";

export type Signature = { path: string; width: number; height: number };
const WIDTH = 320;
const HEIGHT = 170;

// The customer signs with a finger; the drawing is kept as an SVG path (light, printable on the delivery note).
export function SignatureModal({ visible, title, required, onClose, onSigned }: {
  visible: boolean;
  title: string;
  required: boolean;
  onClose: () => void;
  onSigned: (signature: Signature | null, signer: string) => void;
}) {
  const [strokes, setStrokes] = useState<string[]>([]);
  const [signer, setSigner] = useState("");
  const current = useRef("");
  const [, redraw] = useState(0);

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => {
      const { locationX, locationY } = event.nativeEvent;
      current.current = `M${locationX.toFixed(1)} ${locationY.toFixed(1)}`;
      redraw((value) => value + 1);
    },
    onPanResponderMove: (event) => {
      const { locationX, locationY } = event.nativeEvent;
      current.current += ` L${locationX.toFixed(1)} ${locationY.toFixed(1)}`;
      redraw((value) => value + 1);
    },
    onPanResponderRelease: () => {
      const stroke = current.current;
      current.current = "";
      if (stroke.includes("L")) setStrokes((list) => [...list, stroke]);
      redraw((value) => value + 1);
    },
  })).current;

  const path = [...strokes, current.current].filter(Boolean).join(" ");
  const empty = strokes.length === 0;

  function done() {
    onSigned(empty ? null : { path: strokes.join(" "), width: WIDTH, height: HEIGHT }, signer);
    setStrokes([]);
    setSigner("");
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="REMISE AU CLIENT" title={title} right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={[ui.content, { alignItems: "center" }]} scrollEnabled={false}>
        <Text style={[ui.small, { marginTop: 10, textAlign: "center" }]}>Le client signe dans le cadre avec le doigt.</Text>
        <View style={styles.pad} {...responder.panHandlers}>
          <Svg width={WIDTH} height={HEIGHT}>
            <Path d={path || "M0 0"} stroke={colors.text} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
          {empty && !current.current ? <Text style={styles.placeholder}>Signature du client</Text> : null}
        </View>
        <View style={{ width: WIDTH }}>
          <Field label="Nom du signataire" value={signer} onChangeText={setSigner} placeholder="Ex. M. Ben Salah" autoCapitalize="words" />
        </View>
        <View style={[ui.wrapRow, { marginTop: 12, width: WIDTH }]}>
          <Button label="EFFACER" variant="secondary" onPress={() => setStrokes([])} />
          <Button label={empty && !required ? "CONTINUER SANS SIGNATURE" : "VALIDER LA SIGNATURE"} onPress={done} disabled={empty && required} style={{ flexGrow: 1 }} />
        </View>
        {required ? <Text style={[ui.small, { marginTop: 8, color: colors.amber }]}>Ce client signe obligatoirement à la livraison.</Text> : null}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  pad: { width: WIDTH, height: HEIGHT, marginTop: 10, borderRadius: 12, borderWidth: 2, borderColor: colors.green, borderStyle: "dashed", backgroundColor: colors.white, overflow: "hidden" },
  placeholder: { position: "absolute", top: HEIGHT / 2 - 10, width: WIDTH, textAlign: "center", color: colors.line, fontSize: 18, fontWeight: "800" },
});
