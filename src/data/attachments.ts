import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { supabase } from "../lib/supabase";

export type AttachmentKind = "image" | "video" | "audio" | "file";
// Stored on the message once uploaded (see 20261101_message_attachments.sql).
export type Attachment = { path: string; kind: AttachmentKind; name: string; size: number; mime: string };
// Picked on the device, not uploaded yet.
export type LocalFile = { uri: string; kind: AttachmentKind; name: string; size: number; mime: string };

const MAX_SIZE = 25 * 1024 * 1024;

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

const kindOf = (mime: string): AttachmentKind => mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";

export async function pickMedia(source: "camera" | "library"): Promise<LocalFile | null> {
  const permission = source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error(source === "camera" ? "Autorisez l’appareil photo dans les réglages du téléphone." : "Autorisez l’accès aux photos dans les réglages du téléphone.");
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images", "videos"], quality: 0.7, videoMaxDuration: 120 };
  const result = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const mime = asset.mimeType ?? (asset.type === "video" ? "video/mp4" : "image/jpeg");
  return { uri: asset.uri, kind: asset.type === "video" ? "video" : "image", name: asset.fileName ?? (asset.type === "video" ? "video.mp4" : "photo.jpg"), size: asset.fileSize ?? 0, mime };
}

export async function pickDocument(): Promise<LocalFile | null> {
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const mime = asset.mimeType ?? "application/octet-stream";
  return { uri: asset.uri, kind: kindOf(mime), name: asset.name, size: asset.size ?? 0, mime };
}

// Uploads into the conversation's folder: client/<client id> or team/<conversation id>.
export async function uploadAttachment(folder: string, file: LocalFile): Promise<Attachment> {
  if (file.size > MAX_SIZE) throw new Error("Fichier trop lourd : 25 Mo au maximum.");
  const body = await (await fetch(file.uri)).arrayBuffer();
  if (body.byteLength > MAX_SIZE) throw new Error("Fichier trop lourd : 25 Mo au maximum.");
  const safeName = file.name.normalize("NFD").replace(/[^\w.-]+/g, "-").slice(-80) || "fichier";
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const { error } = await client().storage.from("attachments").upload(path, body, { contentType: file.mime, upsert: false });
  if (error) throw error;
  return { path, kind: file.kind, name: file.name, size: body.byteLength, mime: file.mime };
}

// Private files: a short-lived link to show or open them.
const signedCache = new Map<string, { url: string; until: number }>();
export async function attachmentUrl(path: string): Promise<string> {
  const cached = signedCache.get(path);
  if (cached && cached.until > Date.now()) return cached.url;
  const { data, error } = await client().storage.from("attachments").createSignedUrl(path, 3600);
  if (error || !data) throw error ?? new Error("Fichier indisponible.");
  signedCache.set(path, { url: data.signedUrl, until: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}

export const formatSize = (size: number) => size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(size / 1024))} Ko`;
