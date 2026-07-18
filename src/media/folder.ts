import { StorageAccessFramework } from 'expo-file-system/legacy';
import { mediaItemFromSafUri, type MediaItem } from './mime';

/**
 * Let the user grant access to a folder and return every media file directly inside
 * it, sorted by name (a natural playlist order). Uses the Storage Access Framework:
 * requestDirectoryPermissionsAsync() shows the folder picker, then readDirectoryAsync()
 * lists the child `content://` URIs — which our copy + ffmpeg pipeline already handles.
 *
 * Non-media files and subdirectories are filtered out (see {@link mediaItemFromSafUri}).
 * Listing is NOT recursive: only files directly in the chosen folder are added — deep
 * trees would need per-subfolder permission prompts, which we deliberately avoid.
 * Returns null if the user cancels the prompt (so the caller can distinguish a cancel
 * from a folder that genuinely contains no media, which returns []).
 */
export async function pickFolderMedia(): Promise<MediaItem[] | null> {
  const perm = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!perm.granted) return null;
  const uris = await StorageAccessFramework.readDirectoryAsync(perm.directoryUri);
  const items: MediaItem[] = [];
  for (const uri of uris) {
    const item = mediaItemFromSafUri(uri);
    if (item) items.push(item);
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
