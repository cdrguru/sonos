// Wire protocol between the LAN bridge and the Expo web client.
// Keep in sync with core/bridgeProtocol.ts in the app.

export type LogLevel = 'info' | 'warn' | 'success' | 'error';

export interface BridgeTrack {
  title: string;
  artist: string;
  album: string;
  artwork: string;
  duration: number;
  progress: number;
}

export interface BridgePlayer {
  id: string;
  name: string;
  ip: string;
  model: string;
  status: 'playing' | 'paused' | 'stopped' | 'offline';
  volume: number;
  muted: boolean;
  bass: number;
  treble: number;
  loudness: boolean;
  nightMode: boolean;
  zoneCoordinatorId: string;
  zoneMemberIds: string[];
  currentTrack: BridgeTrack | null;
}

export type RpcMethod =
  | 'discovery.refresh'
  | 'player.setVolume'
  | 'player.setMute'
  | 'player.setEQ'
  | 'transport.play'
  | 'transport.pause'
  | 'transport.seek'
  | 'transport.next'
  | 'transport.prev'
  | 'zone.group'
  | 'zone.ungroup';

export interface RpcRequest {
  kind: 'rpc';
  id: string;
  method: RpcMethod;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  kind: 'rpc-response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type BridgeEvent =
  | { kind: 'event'; type: 'topology'; players: BridgePlayer[] }
  | {
      kind: 'event';
      type: 'player.volume';
      playerId: string;
      volume: number;
      muted: boolean;
    }
  | {
      kind: 'event';
      type: 'player.transport';
      playerId: string;
      status: BridgePlayer['status'];
      currentTrack: BridgeTrack | null;
    }
  | {
      kind: 'event';
      type: 'log';
      level: LogLevel;
      protocol: 'SSDP' | 'UPnP' | 'GENA' | 'SYSTEM';
      message: string;
    };

export type BridgeMessage = RpcRequest | RpcResponse | BridgeEvent;
