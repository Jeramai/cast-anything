import * as DocumentPicker from 'expo-document-picker';
import { guessMime, kindFromMime, type MediaItem } from './mime';

// Re-export the pure helpers so existing imports (`../media/media`) keep working.
export * from './mime';

/** Map a DocumentPicker asset to a MediaItem. */
function assetToMediaItem(asset: DocumentPicker.DocumentPickerAsset): MediaItem {
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

/**
 * Open the system picker allowing one or MULTIPLE files (the caller decides what a
 * single vs. several selections mean). Returns every chosen file as a MediaItem, or
 * [] if cancelled.
 */
export async function pickMediaFiles(): Promise<MediaItem[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['video/*', 'audio/*', 'image/*'],
    // Do NOT let the picker copy files into our cache — for a multi-GB file that copy
    // blocks the UI thread (black screen / unresponsive pick). We get the original
    // location instead (a content:// URI on Android, a file:// temp on iOS) and copy
    // ourselves at cast time, off the UI thread.
    copyToCacheDirectory: false,
    multiple: true,
  });
  if (result.canceled || !result.assets?.length) return [];
  return result.assets.map(assetToMediaItem);
}
