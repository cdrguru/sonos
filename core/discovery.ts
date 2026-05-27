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

// Demo speakers used when no LAN bridge is reachable, so the full UI is
// explorable with zero hardware. Replaced by real topology once the bridge
// connects.
const INITIAL_SPEAKERS: Speaker[] = [
  {
    id: 'spk-living-room',
    name: 'Living Room',
    ip: '192.168.1.101',
    status: 'playing',
    volume: 45,
    zoneId: null,
    model: 'Sonos Era 300',
    pathway: 'local',
    currentTrack: {
      title: 'Ocean Eyes',
      artist: 'Billie Eilish',
      album: 'Dont Smile at Me',
      artwork: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150&auto=format&fit=crop&q=60',
      duration: 200,
      progress: 45,
    },
  },
  {
    id: 'spk-kitchen',
    name: 'Kitchen',
    ip: '192.168.1.102',
    status: 'paused',
    volume: 30,
    zoneId: null,
    model: 'Sonos Era 100',
    pathway: 'local',
    currentTrack: {
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      album: 'After Hours',
      artwork: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150&auto=format&fit=crop&q=60',
      duration: 200,
      progress: 0,
    },
  },
  {
    id: 'spk-master-bedroom',
    name: 'Master Bedroom',
    ip: '192.168.1.103',
    status: 'stopped',
    volume: 20,
    zoneId: null,
    model: 'Sonos Move 2',
    pathway: 'local',
    currentTrack: {
      title: 'Come Away With Me',
      artist: 'Norah Jones',
      album: 'Come Away With Me',
      artwork: 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=150&auto=format&fit=crop&q=60',
      duration: 198,
      progress: 0,
    },
  },
  {
    id: 'spk-patio',
    name: 'Patio',
    ip: '192.168.1.104',
    status: 'offline',
    volume: 50,
    zoneId: null,
    model: 'Sonos Roam 2',
    pathway: 'local',
    currentTrack: undefined,
  },
  {
    id: 'spk-office',
    name: 'Home Office',
    ip: '192.168.1.105',
    status: 'playing',
    volume: 35,
    zoneId: null,
    model: 'Sonos Five',
    pathway: 'local',
    currentTrack: {
      title: 'Time',
      artist: 'Pink Floyd',
      album: 'The Dark Side of the Moon',
      artwork: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=150&auto=format&fit=crop&q=60',
      duration: 421,
      progress: 180,
    },
  },
];

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

  // Simulation fallback (active only while no LAN bridge is connected).
  private simulating = false;
  private simIntervalId: ReturnType<typeof setInterval> | null = null;
  private simGraceTimer: ReturnType<typeof setTimeout> | null = null;

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
        this.clearSimGrace();
        this.addLog('BRIDGE', 'success', 'Bridge connected. Real LAN discovery online.');
        if (this.simulating) this.exitSimulation();
      } else if (status === 'disconnected') {
        this.addLog('BRIDGE', 'warn', 'Bridge unavailable. Falling back to local simulation.');
        this.scheduleSimFallback();
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
    // If the bridge doesn't answer quickly, drop into simulation so the UI
    // is usable with no hardware.
    this.scheduleSimFallback();
  }

  stop() {
    this.unsubBridgeEvents?.();
    this.unsubBridgeTopology?.();
    this.unsubBridgeStatus?.();
    this.unsubBridgeEvents = null;
    this.unsubBridgeTopology = null;
    this.unsubBridgeStatus = null;
    this.clearSimGrace();
    if (this.simIntervalId) {
      clearInterval(this.simIntervalId);
      this.simIntervalId = null;
    }
    bridgeClient.disconnect();
    this.addLog('SYSTEM', 'info', 'Discovery Engine stopped.');
  }

  isSimulating(): boolean {
    return this.simulating;
  }

  // ---------- simulation fallback ----------

  private scheduleSimFallback() {
    if (this.simulating || this.simGraceTimer) return;
    this.simGraceTimer = setTimeout(() => {
      this.simGraceTimer = null;
      if (bridgeClient.getStatus() !== 'connected' && !this.simulating) {
        this.enterSimulation();
      }
    }, 1200);
  }

  private clearSimGrace() {
    if (this.simGraceTimer) {
      clearTimeout(this.simGraceTimer);
      this.simGraceTimer = null;
    }
  }

  private enterSimulation() {
    if (this.simulating) return;
    this.simulating = true;
    this.clearSimGrace();

    // Seed demo speakers unless the cache already gave us some to bring online.
    const hasKnown = this.speakers.length > 0;
    this.speakers = hasKnown
      ? this.speakers.map((s) =>
          s.id === 'spk-patio' ? { ...s, status: 'offline' } : { ...s, status: s.status === 'offline' ? 'stopped' : s.status },
        )
      : [...INITIAL_SPEAKERS];

    this.addLog('SYSTEM', 'warn', 'No LAN bridge reachable — running in local simulation mode with demo speakers.');
    this.runSimulatedDiscovery();
    this.simIntervalId = setInterval(() => this.runSimulatedPings(), 5000);
    void this.persistSpeakers();
    this.notifyListeners();
  }

  private exitSimulation() {
    if (!this.simulating) return;
    this.simulating = false;
    if (this.simIntervalId) {
      clearInterval(this.simIntervalId);
      this.simIntervalId = null;
    }
    // Drop demo speakers; the bridge's topology sweep repopulates with real ones.
    this.speakers = [];
    this.addLog('SYSTEM', 'info', 'Bridge online — leaving simulation mode.');
    this.notifyListeners();
  }

  private runSimulatedDiscovery() {
    this.addLog('SSDP', 'info', 'M-SEARCH * urn:schemas-upnp-org:device:ZonePlayer:1 (simulated)');
    for (const s of this.speakers) {
      if (s.status !== 'offline') {
        this.addLog('SSDP', 'success', `SSDP reply from ${s.name} (${s.ip}) — LOCATION http://${s.ip}:1400/xml/device_description.xml`);
        this.addLog('mDNS', 'success', `mDNS service: _sonos-${s.id}._tcp.local -> ${s.ip}:1400`);
      }
    }
    this.addLog('SYSTEM', 'success', 'Simulated topology stable.');
    this.notifyListeners();
  }

  private runSimulatedPings() {
    let changed = false;
    this.speakers = this.speakers.map((spk) => {
      // Patio randomly drops/recovers to exercise offline handling.
      if (spk.id === 'spk-patio' && Math.random() > 0.7) {
        const nextStatus = spk.status === 'offline' ? 'stopped' : 'offline';
        if (nextStatus === 'offline') {
          this.addLog('PING', 'warn', `Patio (${spk.ip}) heartbeat lost. Dropping connection.`);
        } else {
          this.addLog('SSDP', 'success', `NOTIFY ssdp:alive from Patio (${spk.ip}).`);
        }
        changed = true;
        return { ...spk, status: nextStatus, volume: nextStatus === 'offline' ? spk.volume : 50 };
      }
      // Advance playback progress on playing speakers.
      if (spk.status === 'playing' && spk.currentTrack) {
        const progress = spk.currentTrack.progress + 5 >= spk.currentTrack.duration ? 0 : spk.currentTrack.progress + 5;
        changed = true;
        return { ...spk, currentTrack: { ...spk.currentTrack, progress } };
      }
      return spk;
    });
    if (changed) {
      void this.persistSpeakers();
      this.notifyListeners();
    }
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
    // Real players arriving means the bridge is authoritative — leave simulation.
    if (incoming.length > 0 && this.simulating) this.exitSimulation();
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
   * Trigger a fresh SSDP sweep — via the bridge when connected, otherwise
   * against the local simulation.
   */
  async runParallelDiscovery() {
    if (bridgeClient.getStatus() === 'connected') {
      this.addLog('BRIDGE', 'info', 'Requesting bridge SSDP refresh...');
      try {
        await bridgeClient.rpc('discovery.refresh');
      } catch (err: any) {
        this.addLog('BRIDGE', 'warn', `Refresh failed: ${err?.message ?? err}`);
      }
      return;
    }
    if (!this.simulating) this.enterSimulation();
    else this.runSimulatedDiscovery();
  }

  /**
   * Manually trigger a network event from the simulation UI. In real-LAN mode
   * the drop/restore/new_speaker controls are no-ops (hardware drives state);
   * the large-subnet GENA demo always runs.
   */
  async simulateNetworkEvent(eventType: 'drop' | 'restore' | 'new_speaker' | 'large_subnet') {
    if (eventType !== 'large_subnet' && bridgeClient.getStatus() === 'connected') {
      this.addLog('SYSTEM', 'info', `"${eventType}" simulation is a no-op against the live bridge.`);
      return;
    }
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
      this.addLog('SYSTEM', 'warn', 'Simulating packet loss: dropping Kitchen and Patio...');
      this.speakers = this.speakers.map((s) =>
        s.id === 'spk-kitchen' || s.id === 'spk-patio' ? { ...s, status: 'offline' } : s,
      );
    } else if (eventType === 'restore') {
      this.addLog('SYSTEM', 'success', 'Simulating network recovery: re-discovering all nodes...');
      this.speakers = this.speakers.map((s) => {
        if (s.id === 'spk-kitchen') return { ...s, status: 'paused', pathway: 'local' as const };
        if (s.id === 'spk-patio') return { ...s, status: 'stopped', pathway: 'local' as const };
        return s;
      });
      this.runSimulatedDiscovery();
    } else if (eventType === 'new_speaker') {
      if (this.speakers.some((s) => s.id === 'spk-garage')) {
        this.addLog('SYSTEM', 'warn', 'Garage speaker is already discovered.');
        return;
      }
      this.addLog('mDNS', 'success', 'Discovered new device: Garage (_sonos-era100._tcp.local) at 192.168.1.110');
      this.speakers = [
        ...this.speakers,
        {
          id: 'spk-garage',
          name: 'Garage',
          ip: '192.168.1.110',
          status: 'stopped',
          volume: 25,
          zoneId: null,
          model: 'Sonos Era 100',
          pathway: 'local',
        },
      ];
    }
    await this.persistSpeakers();
    this.notifyListeners();
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
