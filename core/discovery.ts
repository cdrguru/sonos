import AsyncStorage from '@react-native-async-storage/async-storage';
import { bridgeClient } from './bridgeClient';
import type { BridgeEvent, BridgePlayer } from './bridgeProtocol';

export interface SpeakerEQ {
  bass: number; // -10..+10
  treble: number; // -10..+10
  loudness: boolean;
  nightMode: boolean;
}

export const DEFAULT_EQ: SpeakerEQ = {
  bass: 0,
  treble: 0,
  loudness: false,
  nightMode: false,
};

export interface Speaker {
  id: string;
  name: string;
  ip: string;
  status: 'playing' | 'paused' | 'stopped' | 'offline';
  volume: number;
  muted?: boolean;
  eq?: SpeakerEQ;
  isUncalibrated?: boolean;
  zoneId: string | null;
  model: string;
  pathway?: 'local' | 'cloud';
  currentTrack?: {
    title: string;
    artist: string;
    album: string;
    artwork: string;
    duration: number;
    progress: number;
    url?: string;
  };
}

export interface NetworkLog {
  timestamp: string;
  level: 'info' | 'warn' | 'success' | 'error';
  message: string;
  protocol:
    | 'SSDP'
    | 'mDNS'
    | 'CACHE'
    | 'PING'
    | 'SYSTEM'
    | 'CLOUD'
    | 'UPnP'
    | 'GENA'
    | 'BRIDGE';
}

const STORAGE_KEY = '@sonos_vnext_speaker_registry';

function mapBridgePlayerToSpeaker(p: BridgePlayer): Speaker {
  const inZone = p.zoneMemberIds.length > 1;
  return {
    id: p.id,
    name: p.name,
    ip: p.ip,
    status: p.status,
    volume: p.volume,
    muted: p.muted,
    eq: {
      bass: p.bass,
      treble: p.treble,
      loudness: p.loudness,
      nightMode: p.nightMode,
    },
    zoneId: inZone ? `zone-${p.zoneCoordinatorId}` : null,
    model: p.model,
    pathway: 'local',
    currentTrack: p.currentTrack
      ? {
          title: p.currentTrack.title,
          artist: p.currentTrack.artist,
          album: p.currentTrack.album,
          artwork: p.currentTrack.artwork,
          duration: p.currentTrack.duration,
          progress: p.currentTrack.progress,
          url: p.currentTrack.url,
        }
      : undefined,
  };
}

export class ResilientDiscoveryEngine {
  private speakers: Speaker[] = [];
  private listeners: ((speakers: Speaker[]) => void)[] = [];
  private logListeners: ((logs: NetworkLog[]) => void)[] = [];
  private discoveryLogs: NetworkLog[] = [];
  private unsubBridgeEvents: (() => void) | null = null;
  private unsubBridgeTopology: (() => void) | null = null;
  private unsubBridgeStatus: (() => void) | null = null;

  constructor() {
    this.addLog('SYSTEM', 'info', 'ResilientDiscoveryEngine initialized.');
  }

  public addLog(
    protocol: NetworkLog['protocol'],
    level: NetworkLog['level'],
    message: string,
  ) {
    const logEntry: NetworkLog = {
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
      protocol,
    };
    this.discoveryLogs = [logEntry, ...this.discoveryLogs].slice(0, 80);
    this.notifyLogListeners();
  }

  async start() {
    this.addLog('SYSTEM', 'info', 'Hydrating speaker registry from cache...');
    await this.loadSpeakersFromRegistry();

    this.addLog('BRIDGE', 'info', 'Connecting to LAN bridge at ws://localhost:8765');
    this.unsubBridgeStatus = bridgeClient.subscribeStatus((status) => {
      if (status === 'connected') {
        this.addLog('BRIDGE', 'success', 'Bridge connected. Real LAN discovery online.');
      } else if (status === 'disconnected') {
        this.addLog('BRIDGE', 'warn', 'Bridge disconnected. Falling back to cached topology.');
      } else if (status === 'connecting') {
        this.addLog('BRIDGE', 'info', 'Bridge connecting...');
      }
    });

    this.unsubBridgeTopology = bridgeClient.subscribeTopology((players) => {
      this.applyBridgeTopology(players);
    });

    this.unsubBridgeEvents = bridgeClient.subscribeEvents((event) => {
      this.handleBridgeEvent(event);
    });

    bridgeClient.connect();
  }

  stop() {
    this.unsubBridgeEvents?.();
    this.unsubBridgeTopology?.();
    this.unsubBridgeStatus?.();
    this.unsubBridgeEvents = null;
    this.unsubBridgeTopology = null;
    this.unsubBridgeStatus = null;
    bridgeClient.disconnect();
    this.addLog('SYSTEM', 'info', 'Discovery Engine stopped.');
  }

  private async loadSpeakersFromRegistry() {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY);
      if (data) {
        const cached: Speaker[] = JSON.parse(data);
        // Cached speakers come back as offline until the bridge confirms them.
        this.speakers = cached.map((s) => ({ ...s, status: 'offline' as const }));
        this.addLog(
          'CACHE',
          'success',
          `Loaded ${this.speakers.length} cached speaker(s); awaiting bridge to mark live.`,
        );
      } else {
        this.speakers = [];
        this.addLog('SYSTEM', 'info', 'No cached registry. Waiting for first bridge sweep.');
      }
      this.notifyListeners();
    } catch (e: any) {
      this.addLog('SYSTEM', 'error', `Failed to load speaker registry: ${e.message}`);
      this.speakers = [];
      this.notifyListeners();
    }
  }

  private async persistSpeakers() {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.speakers));
    } catch (e: any) {
      this.addLog('SYSTEM', 'error', `Failed to persist speakers: ${e.message}`);
    }
  }

  private applyBridgeTopology(players: BridgePlayer[]) {
    const incoming = players.map(mapBridgePlayerToSpeaker);
    const incomingIds = new Set(incoming.map((s) => s.id));

    // Existing speakers not in the new topology are kept but marked offline.
    const merged: Speaker[] = [...incoming];
    for (const old of this.speakers) {
      if (!incomingIds.has(old.id)) {
        merged.push({ ...old, status: 'offline' });
      }
    }

    this.speakers = merged;
    this.addLog(
      'SSDP',
      'success',
      `Bridge topology applied: ${incoming.length} live player(s).`,
    );
    void this.persistSpeakers();
    this.notifyListeners();
  }

  private handleBridgeEvent(event: BridgeEvent) {
    if (event.type === 'player.volume') {
      this.speakers = this.speakers.map((s) =>
        s.id === event.playerId ? { ...s, volume: event.volume, muted: event.muted } : s,
      );
      this.notifyListeners();
    } else if (event.type === 'player.transport') {
      this.speakers = this.speakers.map((s) => {
        if (s.id !== event.playerId) return s;
        return {
          ...s,
          status: event.status,
          currentTrack: event.currentTrack
            ? {
                title: event.currentTrack.title,
                artist: event.currentTrack.artist,
                album: event.currentTrack.album,
                artwork: event.currentTrack.artwork,
                duration: event.currentTrack.duration,
                progress: event.currentTrack.progress,
                url: event.currentTrack.url,
              }
            : undefined,
        };
      });
      this.notifyListeners();
    } else if (event.type === 'log') {
      const proto: NetworkLog['protocol'] =
        event.protocol === 'UPnP' || event.protocol === 'GENA' || event.protocol === 'SSDP'
          ? event.protocol
          : 'BRIDGE';
      this.addLog(proto, event.level, event.message);
    }
  }

  /**
   * Trigger a fresh SSDP sweep via the bridge.
   */
  async runParallelDiscovery() {
    this.addLog('BRIDGE', 'info', 'Requesting bridge SSDP refresh...');
    try {
      await bridgeClient.rpc('discovery.refresh');
    } catch (err: any) {
      this.addLog('BRIDGE', 'warn', `Refresh failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Compat shim for legacy simulation UI: the only event that still maps to a
   * real action is a re-scan.
   */
  async simulateNetworkEvent(eventType: 'drop' | 'restore' | 'new_speaker' | 'large_subnet') {
    if (eventType === 'large_subnet') {
      this.addLog('SYSTEM', 'warn', 'Large Subnet Triggered: 21 new speakers detected via SSDP.');
      this.addLog('SSDP', 'warn', 'WARNING: Subnet exceeds 20 speakers. SOAP Polling disabled due to 16KB XML buffer limit.');
      this.addLog('GENA', 'info', 'Establishing HTTP SUBSCRIBE connections to GENA event streams...');
      
      // Simulate GENA subscription logs
      for (let i = 1; i <= 3; i++) {
        setTimeout(() => {
          this.addLog('GENA', 'success', `GENA Subscription ACTIVE: http://192.168.1.13${i}:1400/MediaRenderer/AVTransport/Event`);
          this.addLog('GENA', 'info', `NOTIFY /MediaRenderer/AVTransport/Event HTTP/1.1\nSID: uuid:gena-sub-${i}\nSEQ: 0\nContent-Length: 4096\n\n<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">\n  <e:property>\n    <LastChange>&lt;Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVTransport/"&gt;&lt;InstanceID val="0"&gt;...&lt;/InstanceID&gt;&lt;/Event&gt;</LastChange>\n  </e:property>\n</e:propertyset>`);
        }, i * 300);
      }
      return;
    }

    if (eventType === 'drop') {
      this.addLog(
        'SYSTEM',
        'warn',
        'Lossy Net simulation is a no-op against real hardware.',
      );
      return;
    }
    await this.runParallelDiscovery();
  }

  getSpeakersSync(): Speaker[] {
    return this.speakers;
  }

  async updateSpeakerTopology(updated: Speaker[]) {
    this.speakers = updated;
    await this.persistSpeakers();
    this.notifyListeners();
  }

  onTopologyChange(callback: (speakers: Speaker[]) => void): () => void {
    this.listeners.push(callback);
    callback([...this.speakers]);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  onLogsChange(callback: (logs: NetworkLog[]) => void): () => void {
    this.logListeners.push(callback);
    callback([...this.discoveryLogs]);
    return () => {
      this.logListeners = this.logListeners.filter((cb) => cb !== callback);
    };
  }

  private notifyListeners() {
    this.listeners.forEach((cb) => cb([...this.speakers]));
  }

  private notifyLogListeners() {
    this.logListeners.forEach((cb) => cb([...this.discoveryLogs]));
  }
}

export const discoveryEngine = new ResilientDiscoveryEngine();
