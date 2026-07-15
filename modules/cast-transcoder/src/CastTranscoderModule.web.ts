import { registerWebModule, NativeModule } from 'expo';

type CastTranscoderEvents = {
  onTranscodeProgress: (event: { progress: number }) => void;
};

// No hardware transcode on web.
class CastTranscoderModule extends NativeModule<CastTranscoderEvents> {
  async transcode(_i: string, _o: string, _h: number, _w: number): Promise<string> {
    throw new Error('Native transcoder is not available on web');
  }
  cancel(): void {}
}

export default registerWebModule(CastTranscoderModule, 'CastTranscoderModule');
