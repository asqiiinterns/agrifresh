// OpenStreetMap embed centred on a position (about 1 km around), with a marker.
export function mapEmbedUrl(latitude: number, longitude: number) {
  const d = 0.006;
  const bbox = [longitude - d, latitude - d, longitude + d, latitude + d].map((value) => value.toFixed(6)).join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

export const externalMapUrl = (latitude: number, longitude: number) => `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
