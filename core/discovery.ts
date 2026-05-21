import AsyncStorage from '@react-native-async-storage/async-storage';

export interface SpeakerEQ {
  bass: number;      // -10..+10
  treble: number;    // -10..+10
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
  zoneId: string | null; // null if independent, otherwise shared zone ID
  model: string;
  pathway?: 'local' | 'cloud'; // Current connection routing path
  currentTrack?: {
    title: string;
    artist: string;
    album: string;
    artwork: string;
    duration: number; // in seconds
    progress: number; // in seconds
  };
}

export interface NetworkLog {
  timestamp: string;
  level: 'info' | 'warn' | 'success' | 'error';
  message: string;
  protocol: 'SSDP' | 'mDNS' | 'CACHE' | 'PING' | 'SYSTEM' | 'CLOUD';
}

const STORAGE_KEY = '@sonos_vnext_speaker_registry';

// Initial Mock Speakers
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

export class ResilientDiscoveryEngine {
  private speakers: Speaker[] = [];
  private listeners: ((speakers: Speaker[]) => void)[] = [];
  private logListeners: ((logs: NetworkLog[]) => void)[] = [];
  private pingIntervalId: NodeJS.Timeout | null = null;
  private discoveryLogs: NetworkLog[] = [];

  constructor() {
    this.addLog('SYSTEM', 'info', 'ResilientDiscoveryEngine initialized.');
  }

  public addLog(protocol: NetworkLog['protocol'], level: NetworkLog['level'], message: string) {
    const logEntry: NetworkLog = {
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
      protocol,
    };
    this.discoveryLogs = [logEntry, ...this.discoveryLogs].slice(0, 80); // Keep last 80 logs
    this.notifyLogListeners();
  }

  /**
   * Initializes the registry database and starts background network polling.
   */
  async start() {
    this.addLog('SYSTEM', 'info', 'Starting Network Discovery Engine...');
    await this.loadSpeakersFromRegistry();

    // Run parallel discovery path immediately
    this.runParallelDiscovery();

    // Start background ping loop (every 5 seconds)
    this.pingIntervalId = setInterval(() => {
      this.runNetworkPings();
    }, 5000);
  }

  /**
   * Stops loops.
   */
  stop() {
    if (this.pingIntervalId) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
    this.addLog('SYSTEM', 'info', 'Discovery Engine stopped.');
  }

  /**
   * Loads speakers from local registry (AsyncStorage SQLite alternative)
   */
  private async loadSpeakersFromRegistry() {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY);
      if (data) {
        this.speakers = JSON.parse(data);
        this.addLog('CACHE', 'success', `Registry DB check: loaded ${this.speakers.length} speakers.`);
      } else {
        this.speakers = [...INITIAL_SPEAKERS];
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.speakers));
        this.addLog('SYSTEM', 'info', 'Initialized default speaker registry database.');
      }
      this.notifyListeners();
    } catch (e: any) {
      this.addLog('SYSTEM', 'error', `Failed to load speaker registry: ${e.message}`);
      this.speakers = [...INITIAL_SPEAKERS];
      this.notifyListeners();
    }
  }

  /**
   * Saves updated speakers to the registry database
   */
  private async persistSpeakers() {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.speakers));
    } catch (e: any) {
      this.addLog('SYSTEM', 'error', `Failed to persist speakers: ${e.message}`);
    }
  }

  /**
   * Simulates multi-path parallel discovery: SSDP, mDNS, and Cache
   */
  async runParallelDiscovery() {
    this.addLog('SYSTEM', 'info', 'Triggering multi-path parallel discovery sweep...');

    // Path 1: SSDP (Simple Service Discovery Protocol)
    const ssdpPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        // Output real-world wire broadcast request
        const msearchPayload = `M-SEARCH * HTTP/1.1
HOST: 239.255.255.250:1900
MAN: "ssdp:discover"
MX: 1
ST: urn:schemas-upnp-org:device:ZonePlayer:1`;
        
        this.addLog('SSDP', 'info', `SSDP Broadcast Multicast Sent:\n${msearchPayload}`);

        // Output real replies from active speakers
        this.speakers.forEach((s) => {
          if (s.status !== 'offline') {
            // Restore speaker to local routing path upon successful LAN discovery
            s.pathway = 'local';
            
            const reply = `HTTP/1.1 200 OK
CACHE-CONTROL: max-age = 1800
LOCATION: http://${s.ip}:1400/xml/device_description.xml
USN: uuid:RINCON_${s.id.toUpperCase()}_01400::urn:schemas-upnp-org:device:ZonePlayer:1`;
            this.addLog('SSDP', 'success', `SSDP Unicast Reply from ${s.name} (${s.ip}):\n${reply}`);

            // Simulate Device XML parsing logic
            const simulatedXml = `<device>
  <roomName>${s.name}</roomName>
  <displayName>${s.model}</displayName>
  <UDN>uuid:RINCON_${s.id.toUpperCase()}_01400</UDN>
</device>`;
            this.addLog('SSDP', 'success', `Parsed Room XML for ${s.name}:\n${simulatedXml}`);
          }
        });
        resolve();
      }, 100);
    });

    // Path 2: mDNS (Multicast DNS)
    const mdnsPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.addLog('mDNS', 'info', 'mDNS Query: TXT PTR records for _sonos._tcp.local');
        this.speakers.forEach((s) => {
          if (s.status !== 'offline') {
            this.addLog('mDNS', 'success', `mDNS Service Discovered: _sonos-${s.id}._tcp.local -> ${s.ip}:1400`);
          }
        });
        resolve();
      }, 80);
    });

    // Path 3: Historical IP Cache Ping
    const cachePromise = new Promise<void>((resolve) => {
      setTimeout(async () => {
        this.addLog('CACHE', 'info', 'Registry cache query: sweeping historical subnet nodes');
        this.speakers.forEach((spk) => {
          this.addLog('CACHE', 'success', `Cache match: Verified speaker ${spk.name} at IP ${spk.ip}`);
        });
        resolve();
      }, 40);
    });

    // Wait for all queries in parallel
    await Promise.all([ssdpPromise, mdnsPromise, cachePromise]);
    this.addLog('SYSTEM', 'success', 'Dual-protocol topology discovery stable.');
    this.notifyListeners();
  }

  /**
   * Background health checks (fired every 5 seconds).
   * Simulates network latency fluctuations, offline state transitions, and music track progress updates.
   */
  private async runNetworkPings() {
    let changed = false;

    this.speakers = this.speakers.map((spk) => {
      // 1. Simulating random connection drops for the Patio (goes online/offline)
      if (spk.id === 'spk-patio') {
        const wasOffline = spk.status === 'offline';
        const transition = Math.random() > 0.7; // 30% chance to toggle Patio status
        if (transition) {
          const nextStatus = wasOffline ? 'stopped' : 'offline';
          
          if (nextStatus === 'offline') {
            this.addLog('PING', 'warn', `Patio (${spk.ip}) heartbeat lost. Dropping connection.`);
          } else {
            // Log real SSDP notify alive payload
            const notify = `NOTIFY * HTTP/1.1
HOST: 239.255.255.250:1900
LOCATION: http://${spk.ip}:1400/xml/device_description.xml
NTS: ssdp:alive`;
            this.addLog('SSDP', 'success', `Periodic NOTIFY multicast received:\n${notify}`);
            spk.pathway = 'local';
          }
          changed = true;
          return { ...spk, status: nextStatus, volume: nextStatus === 'offline' ? spk.volume : 50 };
        }
      }

      // 2. Increment music playback track progress
      if (spk.status === 'playing' && spk.currentTrack) {
        let progress = spk.currentTrack.progress + 5;
        if (progress >= spk.currentTrack.duration) {
          progress = 0; // Loop track
        }
        changed = true;
        return {
          ...spk,
          currentTrack: {
            ...spk.currentTrack,
            progress,
          },
        };
      }

      // 3. Regular ping success logging
      if (spk.status !== 'offline') {
        const pingTimeMs = Math.round(Math.random() * 15 + 5);
        if (Math.random() > 0.7) {
          if (spk.pathway === 'cloud') {
            this.addLog('CLOUD', 'success', `WAN Heartbeat status OK: ${spk.name} connected via api.ws.sonos.com.`);
          } else {
            // Send simulated SOAP GetVolume to check health
            const getVolumeSOAP = `POST /MediaRenderer/RenderingControl/Control HTTP/1.1
SOAPAction: "urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"

<u:GetVolume><Channel>Master</Channel></u:GetVolume>`;
            this.addLog('PING', 'success', `SOAP GetVolume reply from ${spk.name} in ${pingTimeMs}ms (Volume: ${spk.volume}%)`);
          }
        }
      }

      return spk;
    });

    if (changed) {
      await this.persistSpeakers();
      this.notifyListeners();
    }
  }

  /**
   * Force manually triggers a network event (e.g. drop a room completely, add a new speaker, simulate high jitter)
   */
  async simulateNetworkEvent(eventType: 'drop' | 'restore' | 'new_speaker') {
    if (eventType === 'drop') {
      this.addLog('SYSTEM', 'warn', 'Simulating major packet loss: Dropping Kitchen and Patio...');
      this.speakers = this.speakers.map((s) => {
        if (s.id === 'spk-kitchen' || s.id === 'spk-patio') {
          return { ...s, status: 'offline' };
        }
        return s;
      });
    } else if (eventType === 'restore') {
      this.addLog('SYSTEM', 'success', 'Simulating network recovery: Re-discovering all nodes...');
      this.speakers = this.speakers.map((s) => {
        if (s.id === 'spk-kitchen') return { ...s, status: 'paused', pathway: 'local' as const };
        if (s.id === 'spk-patio') return { ...s, status: 'stopped', pathway: 'local' as const };
        return s;
      });
      await this.runParallelDiscovery();
    } else if (eventType === 'new_speaker') {
      const exists = this.speakers.some((s) => s.id === 'spk-garage');
      if (exists) {
        this.addLog('SYSTEM', 'warn', 'Garage speaker is already discovered.');
        return;
      }
      this.addLog('mDNS', 'success', 'Discovered new device! Grouping: Garage (_sonos-era100._tcp.local) at 192.168.1.110');
      const newSpk: Speaker = {
        id: 'spk-garage',
        name: 'Garage',
        ip: '192.168.1.110',
        status: 'stopped',
        volume: 25,
        zoneId: null,
        model: 'Sonos Era 100',
        pathway: 'local',
      };
      this.speakers.push(newSpk);
    }
    await this.persistSpeakers();
    this.notifyListeners();
  }

  /**
   * Returns current active topology
   */
  getSpeakersSync(): Speaker[] {
    return this.speakers;
  }

  /**
   * Update topology externally (e.g., zone grouping, volume change)
   */
  async updateSpeakerTopology(updated: Speaker[]) {
    this.speakers = updated;
    await this.persistSpeakers();
    this.notifyListeners();
  }

  /**
   * Subscriber pattern for topology updates
   */
  onTopologyChange(callback: (speakers: Speaker[]) => void): () => void {
    this.listeners.push(callback);
    callback([...this.speakers]); // Immediate call
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  /**
   * Subscriber pattern for network logging
   */
  onLogsChange(callback: (logs: NetworkLog[]) => void): () => void {
    this.logListeners.push(callback);
    callback([...this.discoveryLogs]); // Immediate call
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

// Single instance for app-wide sharing
export const discoveryEngine = new ResilientDiscoveryEngine();
