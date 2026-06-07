import { Platform } from 'react-native';
import { Album, Asset, requestPermissionsAsync } from 'expo-media-library';

/**
 * Saving a converted file to the device gallery (Movies), so it's "locally
 * available" outside the app's cache. Uses expo-media-library's SDK 56 class API.
 *
 *  - 'cache'     → not handled here (the file just stays in app cache for casting).
 *  - 'new'       → add a fresh asset to the "Cast Anything" album every time.
 *  - 'overwrite' → delete any existing same-named asset in the album first.
 */
export type OutputMode = 'cache' | 'overwrite' | 'new';

const ALBUM = 'Cast Anything';

export async function saveToGallery(
  fileUri: string,
  filename: string,
  mode: Exclude<OutputMode, 'cache'>,
): Promise<void> {
  // Conversion (and therefore this) is Android-only for now.
  if (Platform.OS !== 'android') return;

  // 'new' only writes, 'overwrite' must read the album to find duplicates.
  const perm = await requestPermissionsAsync(mode === 'new', ['video']);
  if (perm.status !== 'granted') throw new Error('Gallery permission was not granted.');

  const album = await Album.get(ALBUM);

  if (mode === 'overwrite' && album) {
    const assets = await album.getAssets();
    const names = await Promise.all(assets.map((a) => a.getFilename()));
    const dups = assets.filter((_, i) => names[i] === filename);
    if (dups.length) await Asset.delete(dups);
  }

  if (album) {
    await Asset.create(fileUri, album);
  } else {
    const asset = await Asset.create(fileUri);
    await Album.create(ALBUM, [asset], true);
  }
}
