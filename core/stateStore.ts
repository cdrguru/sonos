import AsyncStorage from '@react-native-async-storage/async-storage';
import { discoveryEngine, Speaker, NetworkLog, SpeakerEQ, DEFAULT_EQ } from './discovery';
import { LocalFirstSyncEngine, SpeakerVolumeState } from './syncEngine';
export { Speaker, NetworkLog, SpeakerEQ, DEFAULT_EQ };

export interface PlayQueueItem {
  id: string;
  title: string;
  artist: string;
  artwork: string;
  duration: number; // in seconds
}

export interface ZoneGroup {
  id: string; // matches the master speaker's zoneId
  name: string; // e.g. "Living Room + Kitchen"
  masterId: string;
  memberIds: string[];
}

export interface SpeakerSnapshot {
  speakerId: string;
  volume: number;
  muted: boolean;
  eq: SpeakerEQ;
  zoneId: string | null;
}

export interface Scene {
  id: string;
  name: string;
  createdAt: string;
  snapshot: SpeakerSnapshot[];
}

const SCENES_STORAGE_KEY = '@sonos_vnext_scenes';
const QUEUE_STORAGE_KEY = '@sonos_vnext_queue';

export class StateStore {
  private speakers: Speaker[] = [];
  private listeners: ((speakers: Speaker[]) => void)[] = [];
  
  // CRDT Version clocks / sequence counters
  private speakerVersions: Record<string, number> = {};
  
  // Dedicated LocalFirstSyncEngine per speaker
  private syncEngines: Record<string, LocalFirstSyncEngine> = {};

  // Play queue mapping: zoneId/speakerId -> PlayQueueItem[]
  private playQueues: Record<string, PlayQueueItem[]> = {};

  // Persisted user-named scenes / presets
  private scenes: Scene[] = [];
  private sceneListeners: ((scenes: Scene[]) => void)[] = [];
  private queueListeners: ((queue: PlayQueueItem[]) => void)[] = [];

  constructor() {
    // Sync with Discovery Engine topology changes
    discoveryEngine.onTopologyChange((freshSpeakers) => {
      this.reconcileTopology(freshSpeakers);
    });

    // Seed default play queue (overwritten by loadPersistedState if cached)
    this.playQueues['global-queue'] = [
      { id: 'q1', title: 'Ocean Eyes', artist: 'Billie Eilish', artwork: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150&auto=format&fit=crop&q=60', duration: 200 },
      { id: 'q2', title: 'Blinding Lights', artist: 'The Weeknd', artwork: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150&auto=format&fit=crop&q=60', duration: 200 },
      { id: 'q3', title: 'Time', artist: 'Pink Floyd', artwork: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=150&auto=format&fit=crop&q=60', duration: 421 },
      { id: 'q4', title: 'Come Away With Me', artist: 'Norah Jones', artwork: 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=150&auto=format&fit=crop&q=60', duration: 198 },
      { id: 'q5', title: 'Bad Guy', artist: 'Billie Eilish', artwork: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150&auto=format&fit=crop&q=60', duration: 194 },
    ];

    // Hydrate persisted scenes + queue from AsyncStorage
    this.loadPersistedState();
  }

  private async loadPersistedState() {
    try {
      const [scenesRaw, queueRaw] = await Promise.all([
        AsyncStorage.getItem(SCENES_STORAGE_KEY),
        AsyncStorage.getItem(QUEUE_STORAGE_KEY),
      ]);
      if (scenesRaw) {
        this.scenes = JSON.parse(scenesRaw);
        this.notifySceneListeners();
      }
      if (queueRaw) {
        this.playQueues['global-queue'] = JSON.parse(queueRaw);
        this.notifyQueueListeners();
      }
    } catch (e: any) {
      discoveryEngine.addLog('SYSTEM', 'warn', `Failed to load persisted scenes/queue: ${e.message}`);
    }
  }

  private async persistScenes() {
    try {
      await AsyncStorage.setItem(SCENES_STORAGE_KEY, JSON.stringify(this.scenes));
    } catch {}
  }

  private async persistQueue() {
    try {
      await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(this.playQueues['global-queue'] || []));
    } catch {}
  }

  private reconcileTopology(incoming: Speaker[]) {
    const nextSpeakers = incoming.map((inc) => {
      // Lazy initialize sync engine for this speaker
      if (!this.syncEngines[inc.id]) {
        this.syncEngines[inc.id] = new LocalFirstSyncEngine(inc.id, inc.volume);
      }

      const localSpk = this.speakers.find((s) => s.id === inc.id);
      const engine = this.syncEngines[inc.id];
      const seq = this.speakerVersions[inc.id] || 0;

      // Unpack incoming volume updates passively through the conflict resolution engine
      engine.receiveHardwareUpdate(inc.volume, seq, null);

      return {
        ...inc,
        volume: engine.getDisplayVolume(),
        isUncalibrated: localSpk?.isUncalibrated ?? inc.isUncalibrated,
        zoneId: localSpk?.zoneId ?? inc.zoneId,
        pathway: localSpk?.pathway ?? inc.pathway ?? 'local',
        muted: localSpk?.muted ?? inc.muted ?? false,
        eq: localSpk?.eq ?? inc.eq ?? { ...DEFAULT_EQ },
      };
    });

    this.speakers = nextSpeakers;
    this.notifyListeners();
  }

  /**
   * Optimistically update the volume of a speaker or a whole zone
   */
  async setVolume(speakerId: string, newVolume: number) {
    const speaker = this.speakers.find((s) => s.id === speakerId);
    if (!speaker) return;

    // Generate transaction correlation ID
    const correlationId = 'tx-' + Math.random().toString(36).substring(2, 10).toUpperCase();

    // Increment local state version clock
    this.speakerVersions[speakerId] = (this.speakerVersions[speakerId] || 0) + 1;
    const version = this.speakerVersions[speakerId];

    // Lazy initialize sync engine if missing
    if (!this.syncEngines[speakerId]) {
      this.syncEngines[speakerId] = new LocalFirstSyncEngine(speakerId, speaker.volume);
    }

    // Register user interaction immediately in local sync engine (<10ms UI update)
    this.syncEngines[speakerId].registerUserInteraction(newVolume, correlationId);

    // Handle zone groups. If this is part of a zone, we scale all other members proportionately
    if (speaker.zoneId) {
      const zoneMembers = this.speakers.filter((s) => s.zoneId === speaker.zoneId && s.id !== speakerId);
      const volumeDiff = newVolume - speaker.volume;
      zoneMembers.forEach((m) => {
        const mv = Math.min(100, Math.max(0, m.volume + volumeDiff));
        const subCorrelationId = `${correlationId}-${m.id}`;

        this.speakerVersions[m.id] = (this.speakerVersions[m.id] || 0) + 1;
        if (!this.syncEngines[m.id]) {
          this.syncEngines[m.id] = new LocalFirstSyncEngine(m.id, m.volume);
        }
        
        this.syncEngines[m.id].registerUserInteraction(mv, subCorrelationId);
        
        if (m.pathway === 'cloud') {
          this.dispatchCloudSetVolume(m.id, mv, this.speakerVersions[m.id], subCorrelationId);
        } else {
          this.simulateHardwareSetVolume(m.id, mv, this.speakerVersions[m.id], subCorrelationId);
        }
      });
    }

    // Synchronize display volumes to local memory structures
    this.speakers = this.speakers.map((s) => {
      const engine = this.syncEngines[s.id];
      return {
        ...s,
        volume: engine ? engine.getDisplayVolume() : s.volume,
      };
    });
    this.notifyListeners();

    // If speaker is using Cloud routing already, skip SOAP trial and send WAN request directly
    if (speaker.pathway === 'cloud') {
      this.logCloud('info', `Routing SetVolume directly to WAN (Sticky Cloud Fallback path) for ${speaker.name}.`);
      this.dispatchCloudSetVolume(speakerId, newVolume, version, correlationId);
    } else {
      // Formulate a simulated SOAP payload to log (RenderingControl:1 SetVolume)
      this.logSOAPSetVolume(speaker.ip, newVolume, correlationId);
      // Dispatch the asynchronous local UPnP execution block
      this.simulateHardwareSetVolume(speakerId, newVolume, version, correlationId);
    }
  }

  private simulateHardwareSetVolume(speakerId: string, volume: number, version: number, correlationId: string) {
    setTimeout(async () => {
      // Discard this ack if a newer local write superseded it (LWW Resolution)
      if (this.speakerVersions[speakerId] > version) {
        return;
      }

      // Patio has 100% network timeout, others have 10%
      const shouldTimeout = Math.random() > 0.90 || speakerId === 'spk-patio'; 

      if (shouldTimeout) {
        this.logNetwork('warn', `UPnP Timeout (504 Gateway Timeout) on speaker ${speakerId}. Initiating WAN Cloud Failover routing...`);
        
        // Execute Cloud-Fallback command route
        this.dispatchCloudSetVolume(speakerId, volume, version, correlationId);
      } else {
        this.logNetwork('success', `SOAP Reply: SetVolume 200 OK for speaker ${speakerId} (Tx: ${correlationId}).`);
        
        // Finalize transaction with matching correlation ID
        if (this.syncEngines[speakerId]) {
          this.syncEngines[speakerId].receiveHardwareUpdate(volume, version, correlationId);
        }

        this.speakers = this.speakers.map((s) => {
          if (s.id === speakerId) {
            return { ...s, isUncalibrated: false, pathway: 'local' as const };
          }
          return s;
        });

        // Re-read display volume from sync engine
        this.speakers = this.speakers.map((s) => {
          const engine = this.syncEngines[s.id];
          return {
            ...s,
            volume: engine ? engine.getDisplayVolume() : s.volume,
          };
        });

        await discoveryEngine.updateSpeakerTopology(this.speakers);
        this.notifyListeners();
      }
    }, 200);
  }

  private dispatchCloudSetVolume(speakerId: string, volume: number, version: number, correlationId: string) {
    // Generate secure HTTPS request headers
    const bearerToken = 'Bearer us_oauth_token_73d2a091e98bc0098f42bc83c401ee0a';
    const httpsLog = `POST /control/api/v1/players/${speakerId}/playerVolume HTTP/1.1
Host: api.ws.sonos.com
Authorization: ${bearerToken}
Content-Type: application/json

{
  "volume": ${volume}
}`;
    
    this.logCloud('info', `Cloud Fallback API Request Sent:\n${httpsLog}`);

    // Update route pathway state to 'cloud'
    this.speakers = this.speakers.map((s) => {
      if (s.id === speakerId) {
        return { ...s, pathway: 'cloud' as const, isUncalibrated: false }; // clear local warnings since cloud WAN succeeds
      }
      return s;
    });
    this.notifyListeners();

    // WAN response latency is slightly slower than LAN (approx 350ms)
    setTimeout(async () => {
      if (this.speakerVersions[speakerId] > version) {
        return;
      }

      // Simulate incoming server WebSocket push notification payload conforming to schemas
      const wsNotification = `{
  "namespace": "groupVolume",
  "event": "groupVolume",
  "groupId": "RINCON_${speakerId.toUpperCase()}_01400:509930175",
  "body": {
    "volume": ${volume},
    "muted": false,
    "fixed": false
  }
}`;
      
      this.logCloud('success', `WebSocket Event received (Gateway Notification):\n${wsNotification}`);

      // Finalize syncEngine state
      if (this.syncEngines[speakerId]) {
        this.syncEngines[speakerId].receiveHardwareUpdate(volume, version, correlationId);
      }

      this.speakers = this.speakers.map((s) => {
        if (s.id === speakerId) {
          return {
            ...s,
            volume: this.syncEngines[speakerId].getDisplayVolume(),
          };
        }
        return s;
      });

      await discoveryEngine.updateSpeakerTopology(this.speakers);
      this.notifyListeners();
    }, 350);
  }

  private logSOAPSetVolume(ip: string, volume: number, txId: string) {
    const rawSOAP = `POST /MediaRenderer/RenderingControl/Control HTTP/1.1
Host: ${ip}:1400
SOAPAction: "urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"
Tx-Correlation-ID: ${txId}

<u:SetVolume>
  <DesiredVolume>${volume}</DesiredVolume>
</u:SetVolume>`;
    
    discoveryEngine.addLog('SSDP', 'info', `Sending SOAP Volume Set:\n${rawSOAP}`);
  }

  private logNetwork(level: NetworkLog['level'], message: string) {
    discoveryEngine.addLog('PING', level, message);
  }

  private logCloud(level: NetworkLog['level'], message: string) {
    discoveryEngine.addLog('CLOUD', level, message);
  }

  /**
   * Helper to retrieve active state speaker list
   */
  getSpeakers(): Speaker[] {
    return this.speakers;
  }

  /**
   * Helper to get visual sync status for debugging
   */
  getSyncState(speakerId: string): SpeakerVolumeState | undefined {
    return this.syncEngines[speakerId]?.getRawState();
  }

  /**
   * Play/Pause Toggle
   */
  async togglePlayPause(speakerId: string) {
    const speaker = this.speakers.find((s) => s.id === speakerId);
    if (!speaker || speaker.status === 'offline') return;

    const nextStatus = speaker.status === 'playing' ? 'paused' : 'playing';

    if (speaker.pathway === 'cloud') {
      const command = nextStatus === 'playing' ? 'play' : 'pause';
      this.logCloud('info', `POST /control/api/v1/players/${speakerId}/${command} HTTP/1.1`);
    } else {
      const soapAction = nextStatus === 'playing' ? 'Play' : 'Pause';
      discoveryEngine.addLog('SSDP', 'info', `POST /MediaRenderer/AVTransport/Control HTTP/1.1\nSOAPAction: "urn:schemas-upnp-org:service:AVTransport:1#${soapAction}"`);
    }

    this.speakers = this.speakers.map((s) => {
      if (s.id === speakerId) {
        return { ...s, status: nextStatus };
      }
      if (speaker.zoneId && s.zoneId === speaker.zoneId) {
        return { ...s, status: nextStatus };
      }
      return s;
    });
    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);
  }

  /**
   * Merge one speaker into another's zone
   */
  async groupSpeakers(targetSpeakerId: string, dragSpeakerId: string) {
    if (targetSpeakerId === dragSpeakerId) return;

    const target = this.speakers.find((s) => s.id === targetSpeakerId);
    const drag = this.speakers.find((s) => s.id === dragSpeakerId);
    if (!target || !drag || target.status === 'offline' || drag.status === 'offline') return;

    const newZoneId = target.zoneId || `zone-${targetSpeakerId}`;

    if (drag.pathway === 'cloud' || target.pathway === 'cloud') {
      const payload = `{"playerIds": ["${drag.id}", "${target.id}"]}`;
      this.logCloud('info', `POST /control/api/v1/households/h1/groups/createGroup HTTP/1.1\nPayload: ${payload}`);
    } else {
      discoveryEngine.addLog('SSDP', 'info', `POST /MediaRenderer/AVTransport/Control HTTP/1.1\nSOAPAction: "urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"\nURI: x-rincon-join://${target.id}`);
    }

    this.speakers = this.speakers.map((s) => {
      if (s.id === dragSpeakerId) {
        return { 
          ...s, 
          zoneId: newZoneId, 
          status: target.status,
          currentTrack: target.currentTrack ? { ...target.currentTrack } : undefined 
        };
      }
      if (s.id === targetSpeakerId) {
        return { ...s, zoneId: newZoneId };
      }
      return s;
    });

    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);
  }

  /**
   * Separate a speaker from its zone group
   */
  async ungroupSpeaker(speakerId: string) {
    const speaker = this.speakers.find((s) => s.id === speakerId);
    if (!speaker) return;

    if (speaker.pathway === 'cloud') {
      this.logCloud('info', `POST /control/api/v1/groups/${speaker.zoneId}/removePlayer HTTP/1.1\nPlayer: ${speakerId}`);
    } else {
      discoveryEngine.addLog('SSDP', 'info', `POST /MediaRenderer/AVTransport/Control HTTP/1.1\nSOAPAction: "urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"\nURI: x-rincon-standalone`);
    }

    const oldZoneId = speaker.zoneId;

    this.speakers = this.speakers.map((s) => {
      if (s.id === speakerId) {
        return { ...s, zoneId: null, status: 'stopped' as const };
      }
      return s;
    });

    if (oldZoneId) {
      const remaining = this.speakers.filter((s) => s.zoneId === oldZoneId);
      if (remaining.length <= 1) {
        this.speakers = this.speakers.map((s) => {
          if (s.zoneId === oldZoneId) {
            return { ...s, zoneId: null };
          }
          return s;
        });
      }
    }

    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);
  }

  /**
   * Reset the uncalibrated flag
   */
  async calibrateSpeaker(speakerId: string) {
    this.logNetwork('info', `Running calibration sweep for ${speakerId}...`);
    this.speakers = this.speakers.map((s) => {
      if (s.id === speakerId) {
        return { ...s, isUncalibrated: false, pathway: 'local' as const };
      }
      return s;
    });
    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);
  }

  /**
   * Toggle mute on a speaker (and its zone). Logs SetMute SOAP or Cloud equivalent.
   */
  async toggleMute(speakerId: string) {
    const speaker = this.speakers.find((s) => s.id === speakerId);
    if (!speaker || speaker.status === 'offline') return;
    const newMuted = !(speaker.muted ?? false);

    if (speaker.pathway === 'cloud') {
      this.logCloud(
        'info',
        `POST /control/api/v1/players/${speakerId}/playerVolume/mute HTTP/1.1\nHost: api.ws.sonos.com\nContent-Type: application/json\n\n{ "muted": ${newMuted} }`,
      );
    } else {
      discoveryEngine.addLog(
        'SSDP',
        'info',
        `POST /MediaRenderer/RenderingControl/Control HTTP/1.1\nHost: ${speaker.ip}:1400\nSOAPAction: "urn:schemas-upnp-org:service:RenderingControl:1#SetMute"\n\n<u:SetMute>\n  <Channel>Master</Channel>\n  <DesiredMute>${newMuted ? 1 : 0}</DesiredMute>\n</u:SetMute>`,
      );
    }

    this.speakers = this.speakers.map((s) => {
      const inZone = speaker.zoneId && s.zoneId === speaker.zoneId;
      if (s.id === speakerId || inZone) {
        return { ...s, muted: newMuted };
      }
      return s;
    });
    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);
  }

  /**
   * Update equalizer for a single speaker. Logs SetEQ SOAP or Cloud equivalent.
   */
  async setEQ(speakerId: string, eq: SpeakerEQ) {
    const speaker = this.speakers.find((s) => s.id === speakerId);
    if (!speaker) return;

    if (speaker.pathway === 'cloud') {
      this.logCloud(
        'info',
        `POST /control/api/v1/players/${speakerId}/audio/eq HTTP/1.1\nContent-Type: application/json\n\n${JSON.stringify(eq, null, 2)}`,
      );
    } else {
      const eqLog = `POST /MediaRenderer/RenderingControl/Control HTTP/1.1\nHost: ${speaker.ip}:1400\nSOAPAction: "urn:schemas-upnp-org:service:RenderingControl:1#SetEQ"\n\n<u:SetEQ><Bass>${eq.bass}</Bass><Treble>${eq.treble}</Treble><Loudness>${eq.loudness ? 1 : 0}</Loudness><NightMode>${eq.nightMode ? 1 : 0}</NightMode></u:SetEQ>`;
      discoveryEngine.addLog('SSDP', 'info', eqLog);
    }

    this.speakers = this.speakers.map((s) => {
      if (s.id === speakerId) return { ...s, eq: { ...eq } };
      return s;
    });
    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);
  }

  /**
   * Seek to a given progress (seconds) on the currently playing track. Group-aware.
   */
  async seekTo(speakerId: string, seconds: number) {
    const speaker = this.speakers.find((s) => s.id === speakerId);
    if (!speaker || !speaker.currentTrack || speaker.status === 'offline') return;

    const target = Math.max(0, Math.min(Math.round(seconds), speaker.currentTrack.duration));
    const hh = Math.floor(target / 3600);
    const mm = Math.floor((target % 3600) / 60);
    const ss = target % 60;
    const timeStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;

    if (speaker.pathway === 'cloud') {
      this.logCloud(
        'info',
        `POST /control/api/v1/groups/${speaker.zoneId || speakerId}/playback/seek HTTP/1.1\nContent-Type: application/json\n\n{ "positionMillis": ${target * 1000} }`,
      );
    } else {
      discoveryEngine.addLog(
        'SSDP',
        'info',
        `POST /MediaRenderer/AVTransport/Control HTTP/1.1\nHost: ${speaker.ip}:1400\nSOAPAction: "urn:schemas-upnp-org:service:AVTransport:1#Seek"\n\n<u:Seek>\n  <Unit>REL_TIME</Unit>\n  <Target>${timeStr}</Target>\n</u:Seek>`,
      );
    }

    this.speakers = this.speakers.map((s) => {
      const inZone = speaker.zoneId && s.zoneId === speaker.zoneId;
      if ((s.id === speakerId || inZone) && s.currentTrack) {
        return { ...s, currentTrack: { ...s.currentTrack, progress: target } };
      }
      return s;
    });
    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);
  }

  /**
   * Queue Management
   */
  getQueue(): PlayQueueItem[] {
    return this.playQueues['global-queue'] || [];
  }

  async addToQueue(track: PlayQueueItem) {
    const existing = this.playQueues['global-queue'] || [];
    // Avoid duplicate by id; re-add at end if same id present
    const filtered = existing.filter((t) => t.id !== track.id);
    this.playQueues['global-queue'] = [...filtered, track];
    this.logNetwork('success', `Track "${track.title}" appended to global queue (size: ${this.playQueues['global-queue'].length}).`);
    this.notifyQueueListeners();
    await this.persistQueue();
  }

  async removeFromQueue(trackId: string) {
    const existing = this.playQueues['global-queue'] || [];
    this.playQueues['global-queue'] = existing.filter((t) => t.id !== trackId);
    this.logNetwork('info', `Queue item ${trackId} removed.`);
    this.notifyQueueListeners();
    await this.persistQueue();
  }

  async reorderQueue(trackId: string, direction: 'up' | 'down') {
    const list = [...(this.playQueues['global-queue'] || [])];
    const idx = list.findIndex((t) => t.id === trackId);
    if (idx < 0) return;
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= list.length) return;
    [list[idx], list[target]] = [list[target], list[idx]];
    this.playQueues['global-queue'] = list;
    this.notifyQueueListeners();
    await this.persistQueue();
  }

  playTrackFromQueue(speakerId: string, track: PlayQueueItem) {
    const speaker = this.speakers.find((s) => s.id === speakerId);
    if (!speaker) return;

    this.logNetwork('success', `Play queue selected. Dispatching track to transport layer.`);

    this.speakers = this.speakers.map((s) => {
      const shouldUpdate = s.id === speakerId || (speaker.zoneId && s.zoneId === speaker.zoneId);
      if (shouldUpdate) {
        return {
          ...s,
          status: 'playing' as const,
          currentTrack: {
            title: track.title,
            artist: track.artist,
            album: 'Queue Selection',
            artwork: track.artwork,
            duration: track.duration,
            progress: 0,
          },
        };
      }
      return s;
    });

    this.notifyListeners();
    discoveryEngine.updateSpeakerTopology(this.speakers);
  }

  /**
   * Scenes / Presets
   */
  getScenes(): Scene[] {
    return [...this.scenes];
  }

  async saveScene(name: string): Promise<Scene> {
    const snapshot: SpeakerSnapshot[] = this.speakers.map((s) => ({
      speakerId: s.id,
      volume: s.volume,
      muted: s.muted ?? false,
      eq: s.eq ?? { ...DEFAULT_EQ },
      zoneId: s.zoneId,
    }));
    const newScene: Scene = {
      id: `scene-${Date.now()}`,
      name: name.trim() || `Scene ${this.scenes.length + 1}`,
      createdAt: new Date().toISOString(),
      snapshot,
    };
    this.scenes = [...this.scenes, newScene];
    this.logNetwork('success', `Scene "${newScene.name}" persisted with ${snapshot.length} player snapshots to AsyncStorage.`);
    this.notifySceneListeners();
    await this.persistScenes();
    return newScene;
  }

  async applyScene(sceneId: string) {
    const scene = this.scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    this.logNetwork('info', `Applying scene "${scene.name}" (${scene.snapshot.length} players)...`);

    this.speakers = this.speakers.map((s) => {
      const snap = scene.snapshot.find((p) => p.speakerId === s.id);
      if (!snap) return s;
      // Reset sync engine so the restored volume is the new confirmed baseline
      this.syncEngines[s.id] = new LocalFirstSyncEngine(s.id, snap.volume);
      this.speakerVersions[s.id] = (this.speakerVersions[s.id] || 0) + 1;
      return {
        ...s,
        volume: snap.volume,
        muted: snap.muted,
        eq: { ...snap.eq },
        zoneId: snap.zoneId,
      };
    });
    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);
  }

  async deleteScene(sceneId: string) {
    const scene = this.scenes.find((s) => s.id === sceneId);
    this.scenes = this.scenes.filter((s) => s.id !== sceneId);
    if (scene) this.logNetwork('warn', `Scene "${scene.name}" deleted from registry.`);
    this.notifySceneListeners();
    await this.persistScenes();
  }

  /**
   * Subscription interface
   */
  subscribe(callback: (speakers: Speaker[]) => void): () => void {
    this.listeners.push(callback);
    callback([...this.speakers]);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  subscribeScenes(callback: (scenes: Scene[]) => void): () => void {
    this.sceneListeners.push(callback);
    callback([...this.scenes]);
    return () => {
      this.sceneListeners = this.sceneListeners.filter((cb) => cb !== callback);
    };
  }

  subscribeQueue(callback: (queue: PlayQueueItem[]) => void): () => void {
    this.queueListeners.push(callback);
    callback([...(this.playQueues['global-queue'] || [])]);
    return () => {
      this.queueListeners = this.queueListeners.filter((cb) => cb !== callback);
    };
  }

  private notifyListeners() {
    this.listeners.forEach((cb) => cb([...this.speakers]));
  }

  private notifySceneListeners() {
    this.sceneListeners.forEach((cb) => cb([...this.scenes]));
  }

  private notifyQueueListeners() {
    const q = [...(this.playQueues['global-queue'] || [])];
    this.queueListeners.forEach((cb) => cb(q));
  }
}

export const stateStore = new StateStore();
export const getPendingOptimisticVolume = (speakerId: string): number | undefined => {
  const engineState = stateStore.getSyncState(speakerId);
  return engineState?.syncState === 'PENDING' ? engineState.optimisticVolume : undefined;
};
