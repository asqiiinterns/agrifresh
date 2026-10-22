import { createElement } from "react";
import { mapEmbedUrl } from "./mapUrl";

// Web: the same map in an iframe.
export function MapFrame({ latitude, longitude, height = 260 }: { latitude: number; longitude: number; height?: number }) {
  return createElement("iframe", { src: mapEmbedUrl(latitude, longitude), title: "Carte", style: { width: "100%", height, border: 0, borderRadius: 10 } });
}
