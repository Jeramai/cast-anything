import { registerWebModule, NativeModule } from 'expo';

import type { TransportCommand } from './CastKeepAlive.types';

type CastKeepAliveEvents = {
  onTransportCommand: (event: TransportCommand) => void;
};

// There is no phone-hosted file server on web, so keep-alive is a no-op here.
class CastKeepAliveModule extends NativeModule<CastKeepAliveEvents> {
  present(
    _title: string,
    _state: string,
    _position: number,
    _duration: number,
    _controls: boolean,
    _artworkPath?: string,
    _volume?: number,
  ): void {}
  stop(): void {}
}

export default registerWebModule(CastKeepAliveModule, 'CastKeepAliveModule');
