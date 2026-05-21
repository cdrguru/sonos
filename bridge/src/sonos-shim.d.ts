// Minimal ambient types for the `sonos` npm package (no @types available).
declare module 'sonos' {
  import { EventEmitter } from 'node:events';

  export class Sonos extends EventEmitter {
    host: string;
    port: number;
    constructor(host: string, port?: number);
    getVolume(): Promise<number>;
    setVolume(level: number): Promise<unknown>;
    getMuted(): Promise<boolean>;
    setMuted(muted: boolean): Promise<unknown>;
    getCurrentState(): Promise<string>;
    currentTrack(): Promise<unknown>;
    play(): Promise<unknown>;
    pause(): Promise<unknown>;
    stop(): Promise<unknown>;
    next(): Promise<unknown>;
    previous(): Promise<unknown>;
    seek(seconds: number): Promise<unknown>;
    deviceDescription(): Promise<Record<string, unknown>>;
    getZoneAttrs(): Promise<Record<string, unknown>>;
    getZoneInfo(): Promise<Record<string, unknown>>;
    getAllGroups(): Promise<unknown[]>;
    joinGroup(roomName: string): Promise<unknown>;
    leaveGroup(): Promise<unknown>;
    renderingControlService(): {
      SetBass(args: { InstanceID: number; DesiredBass: number }): Promise<unknown>;
      SetTreble(args: { InstanceID: number; DesiredTreble: number }): Promise<unknown>;
      SetLoudness(args: {
        InstanceID: number;
        Channel: string;
        DesiredLoudness: boolean;
      }): Promise<unknown>;
      SetEQ(args: {
        InstanceID: number;
        EQType: string;
        DesiredValue: number;
      }): Promise<unknown>;
    };
  }

  export class AsyncDeviceDiscovery extends EventEmitter {
    discover(options?: { timeout?: number }): Promise<Sonos>;
  }

  const _default: { Sonos: typeof Sonos; AsyncDeviceDiscovery: typeof AsyncDeviceDiscovery };
  export default _default;
}
