import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform, View } from "react-native";

// Android draws edge-to-edge, so the window no longer shrinks under the keyboard: this spacer,
// placed under a composer, grows by exactly the part of the screen the keyboard covers.
// (iOS uses KeyboardAvoidingView; on the web the browser handles it.)
export function KeyboardSpacer() {
  const ref = useRef<View>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      ref.current?.measureInWindow((_x, y) => {
        // y is the spacer's top while it is still 0 high; the keyboard starts at screenY.
        setHeight(Math.max(0, Math.round(y - event.endCoordinates.screenY)));
      });
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  if (Platform.OS !== "android") return null;
  return <View ref={ref} style={{ height }} collapsable={false} />;
}
