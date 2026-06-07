import * as DocumentPicker from 'expo-document-picker';
import { readFile } from '@dr.pogodin/react-native-fs';
import { SUBTITLE_MIME_TYPES, isSubtitleFile } from './subtitleTypes';

/**
 * Let the user pick a subtitle file from their device (no account needed). The
 * picker is narrowed to subtitle MIME types, and the result is validated by
 * extension afterwards because Android reports `.srt` inconsistently. Copies it
 * into cache (subtitle files are tiny) and returns its name + text content.
 */
export async function pickSubtitleFile(): Promise<{ name: string; content: string } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: SUBTITLE_MIME_TYPES,
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  if (!isSubtitleFile(asset.name)) {
    throw new Error('Please pick a subtitle file (.srt, .vtt, .ass, .ssa, .sub).');
  }
  const content = await readFile(asset.uri.replace(/^file:\/\//, ''), 'utf8');
  return { name: asset.name, content };
}
