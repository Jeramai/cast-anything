import * as DocumentPicker from 'expo-document-picker';
import { guessMime, kindFromMime, type MediaItem } from './mime';

// Re-export the pure helpers so existing imports (`../media/media`) keep working.
export * from './mime';

/** Open the system file picker filtered to media types. */
export async function pickMedia(): Promise<MediaItem | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['video/*', 'audio/*', 'image/*'],
    // Do NOT let the picker copy the file into our cache — for a multi-GB file
    // that copy blocks the UI thread (black screen / unresponsive pick). We get
    // the original location instead (a content:// URI on Android, a file:// temp
    // on iOS) and copy it ourselves at cast time, off the UI thread.
    copyToCacheDirectory: false,
    multiple: false,
  });

  if (result.canceled || !result.assets?.length) return null;

  const asset = result.assets[0];
  const mime = guessMime(asset.name, asset.mimeType);
  return {
    uri: asset.uri,
    name: asset.name,
    mime,
    kind: kindFromMime(mime),
    size: asset.size ?? undefined,
    isLocal: true,
  };
}
