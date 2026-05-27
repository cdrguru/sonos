import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio as ExpoAudio } from 'expo-av';
import { discoveryEngine, Speaker, NetworkLog, SpeakerEQ, DEFAULT_EQ } from './discovery';
import { LocalFirstSyncEngine, SpeakerVolumeState } from './syncEngine';
import { bridgeClient } from './bridgeClient';
export { Speaker, NetworkLog, SpeakerEQ, DEFAULT_EQ };

export interface PlayQueueItem {
  id: string;
  title: string;
  artist: string;
  artwork: string;
  duration: number; // in seconds
  url?: string;
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

  // Audio Playback Engine variables
  private activeSound: ExpoAudio.Sound | null = null;
  private activeUrl: string | null = null;
  private selectedSpeakerId: string | null = null;
  private isAudioInitializing: boolean = false;

  constructor() {
    // Sync with Discovery Engine topology changes
    discoveryEngine.onTopologyChange((freshSpeakers) => {
      this.reconcileTopology(freshSpeakers);
    });

    // Seed default play queue (overwritten by loadPersistedState if cached)
    this.playQueues['global-queue'] = [
      { id: 'q1', title: 'Ocean Eyes', artist: 'Billie Eilish', artwork: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150&auto=format&fit=crop&q=60', duration: 200, url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
      { id: 'q2', title: 'Blinding Lights', artist: 'The Weeknd', artwork: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150&auto=format&fit=crop&q=60', duration: 200, url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' },
      { id: 'q3', title: 'Time', artist: 'Pink Floyd', artwork: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=150&auto=format&fit=crop&q=60', duration: 421, url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3' },
      { id: 'q4', title: 'Come Away With Me', artist: 'Norah Jones', artwork: 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=150&auto=format&fit=crop&q=60', duration: 198, url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3' },
      { id: 'q5', title: 'Bad Guy', artist: 'Billie Eilish', artwork: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150&auto=format&fit=crop&q=60', duration: 194, url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3' },
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

    // Dispatch the real LAN volume change via the bridge.
    void this.simulateHardwareSetVolume(speakerId, newVolume, version, correlationId);
  }

  private async simulateHardwareSetVolume(
    speakerId: string,
    volume: number,
    version: number,
    correlationId: string,
  ) {
    // Drop if a newer local write superseded this one (LWW resolution).
    if (this.speakerVersions[speakerId] > version) return;

    // Simulation mode: no bridge to confirm, so treat the optimistic write as
    // the new confirmed value locally instead of flagging it uncalibrated.
    if (bridgeClient.getStatus() !== 'connected') {
      if (this.speakerVersions[speakerId] === version && this.syncEngines[speakerId]) {
        this.syncEngines[speakerId].receiveHardwareUpdate(volume, version, correlationId);
      }
      this.speakers = this.speakers.map((s) => {
        if (s.id !== speakerId) return s;
        const engine = this.syncEngines[s.id];
        return {
          ...s,
          isUncalibrated: false,
          pathway: 'local' as const,
          volume: engine ? engine.getDisplayVolume() : volume,
        };
      });
      this.notifyListeners();
      return;
    }

    try {
      await bridgeClient.rpc('player.setVolume', { playerId: speakerId, volume });
      // Bridge will also push a player.volume event through the topology path,
      // but we close the sync engine immediately so the fader settles fast.
      if (this.speakerVersions[speakerId] === version && this.syncEngines[speakerId]) {
        this.syncEngines[speakerId].receiveHardwareUpdate(volume, version, correlationId);
      }
      this.speakers = this.speakers.map((s) => {
        if (s.id !== speakerId) return s;
        const engine = this.syncEngines[s.id];
        return {
          ...s,
          isUncalibrated: false,
          pathway: 'local' as const,
          volume: engine ? engine.getDisplayVolume() : s.volume,
        };
      });
      this.notifyListeners();
    } catch (err: any) {
      this.logNetwork(
        'warn',
        `Bridge SetVolume failed for ${speakerId} (Tx: ${correlationId}): ${err?.message ?? err}`,
      );
      this.speakers = this.speakers.map((s) =>
        s.id === speakerId ? { ...s, isUncalibrated: true } : s,
      );
      this.notifyListeners();
    }
  }

  private dispatchCloudSetVolume(
    speakerId: string,
    volume: number,
    version: number,
    correlationId: string,
  ) {
    // Cloud path is currently unused — Path B (LAN-direct via bridge) handles
    // everything. Keep the entry point so legacy callers still resolve; just
    // funnel into the same bridge RPC.
    return this.simulateHardwareSetVolume(speakerId, volume, version, correlationId);
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

    this.speakers = this.speakers.map((s) => {
      if (s.id === speakerId) return { ...s, status: nextStatus };
      if (speaker.zoneId && s.zoneId === speaker.zoneId) return { ...s, status: nextStatus };
      return s;
    });
    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);

    try {
      await bridgeClient.rpc(nextStatus === 'playing' ? 'transport.play' : 'transport.pause', {
        playerId: speakerId,
      });
    } catch (err: any) {
      this.logNetwork('warn', `Bridge transport.${nextStatus} failed: ${err?.message ?? err}`);
    }
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

    this.speakers = this.speakers.map((s) => {
      if (s.id === dragSpeakerId) {
        return {
          ...s,
          zoneId: newZoneId,
          status: target.status,
          currentTrack: target.currentTrack ? { ...target.currentTrack } : undefined,
        };
      }
      if (s.id === targetSpeakerId) {
        return { ...s, zoneId: newZoneId };
      }
      return s;
    });

    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);

    try {
      await bridgeClient.rpc('zone.group', {
        coordinatorId: targetSpeakerId,
        memberId: dragSpeakerId,
      });
    } catch (err: any) {
      this.logNetwork('warn', `Bridge zone.group failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Separate a speaker from its zone group
   */
  async ungroupSpeaker(speakerId: string) {
    const speaker = this.speakers.find((s) => s.id === speakerId);
    if (!speaker) return;

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

    try {
      await bridgeClient.rpc('zone.ungroup', { playerId: speakerId });
    } catch (err: any) {
      this.logNetwork('warn', `Bridge zone.ungroup failed: ${err?.message ?? err}`);
    }
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

    this.speakers = this.speakers.map((s) => {
      const inZone = speaker.zoneId && s.zoneId === speaker.zoneId;
      if (s.id === speakerId || inZone) {
        return { ...s, muted: newMuted };
      }
      return s;
    });
    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);

    try {
      await bridgeClient.rpc('player.setMute', { playerId: speakerId, muted: newMuted });
    } catch (err: any) {
      this.logNetwork('warn', `Bridge player.setMute failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Update equalizer for a single speaker. Logs SetEQ SOAP or Cloud equivalent.
   */
  async setEQ(speakerId: string, eq: SpeakerEQ) {
    const speaker = this.speakers.find((s) => s.id === speakerId);
    if (!speaker) return;

    this.speakers = this.speakers.map((s) => {
      if (s.id === speakerId) return { ...s, eq: { ...eq } };
      return s;
    });
    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);

    try {
      await bridgeClient.rpc('player.setEQ', {
        playerId: speakerId,
        bass: eq.bass,
        treble: eq.treble,
        loudness: eq.loudness,
        nightMode: eq.nightMode,
      });
    } catch (err: any) {
      this.logNetwork('warn', `Bridge player.setEQ failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Seek to a given progress (seconds) on the currently playing track. Group-aware.
   */
  async seekTo(speakerId: string, seconds: number) {
    const speaker = this.speakers.find((s) => s.id === speakerId);
    if (!speaker || !speaker.currentTrack || speaker.status === 'offline') return;

    const target = Math.max(0, Math.min(Math.round(seconds), speaker.currentTrack.duration));

    this.speakers = this.speakers.map((s) => {
      const inZone = speaker.zoneId && s.zoneId === speaker.zoneId;
      if ((s.id === speakerId || inZone) && s.currentTrack) {
        return { ...s, currentTrack: { ...s.currentTrack, progress: target } };
      }
      return s;
    });
    this.notifyListeners();
    await discoveryEngine.updateSpeakerTopology(this.speakers);

    try {
      await bridgeClient.rpc('transport.seek', { playerId: speakerId, seconds: target });
    } catch (err: any) {
      this.logNetwork('warn', `Bridge transport.seek failed: ${err?.message ?? err}`);
    }
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
            url: track.url,
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

  setSelectedSpeakerId(id: string | null) {
    if (this.selectedSpeakerId !== id) {
      this.selectedSpeakerId = id;
      this.syncAudioPlayback();
    }
  }

  private async syncAudioPlayback() {
    if (!this.selectedSpeakerId) {
      await this.stopAndUnloadActiveSound();
      return;
    }

    const speaker = this.speakers.find((s) => s.id === this.selectedSpeakerId);
    if (!speaker || speaker.status === 'offline' || !speaker.currentTrack?.url) {
      await this.stopAndUnloadActiveSound();
      return;
    }

    const isMuted = speaker.muted ?? false;
    const targetVolume = isMuted ? 0 : speaker.volume / 100;
    const targetUrl = speaker.currentTrack.url;
    const isPlaying = speaker.status === 'playing';

    // 1. If not playing, pause the audio if it's currently loaded
    if (!isPlaying) {
      if (this.activeSound) {
        try {
          const status = await this.activeSound.getStatusAsync();
          if (status.isLoaded && status.isPlaying) {
            await this.activeSound.pauseAsync();
          }
        } catch (err: any) {
          discoveryEngine.addLog('SYSTEM', 'error', `Error pausing audio: ${err.message}`);
        }
      }
      return;
    }

    // 2. If a new track URL is chosen, load it
    if (this.activeUrl !== targetUrl) {
      await this.stopAndUnloadActiveSound();

      if (this.isAudioInitializing) return;
      this.isAudioInitializing = true;

      try {
        discoveryEngine.addLog('SYSTEM', 'info', `Streaming track "${speaker.currentTrack.title}" by ${speaker.currentTrack.artist}...`);

        await ExpoAudio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          playThroughEarpieceAndroid: false,
          staysActiveInBackground: true,
        });

        const { sound } = await ExpoAudio.Sound.createAsync(
          { uri: targetUrl },
          {
            shouldPlay: true,
            volume: targetVolume,
            positionMillis: speaker.currentTrack.progress * 1000,
          }
        );

        this.activeSound = sound;
        this.activeUrl = targetUrl;
      } catch (err: any) {
        discoveryEngine.addLog('SYSTEM', 'error', `Failed to stream audio: ${err.message}`);
      } finally {
        this.isAudioInitializing = false;
      }
    } else if (this.activeSound) {
      // 3. Otherwise sync volume, play state, and position (seeks)
      try {
        const status = await this.activeSound.getStatusAsync();
        if (status.isLoaded) {
          // Volume check
          if (status.volume !== targetVolume) {
            await this.activeSound.setVolumeAsync(targetVolume);
          }
          // Play state check
          if (!status.isPlaying) {
            await this.activeSound.playAsync();
          }
          // Position drift check (e.g. if seek occurred or there is a drift > 3s)
          const currentPosSec = status.positionMillis / 1000;
          const diff = Math.abs(currentPosSec - speaker.currentTrack.progress);
          if (diff > 3) {
            await this.activeSound.setPositionAsync(speaker.currentTrack.progress * 1000);
          }
        }
      } catch (err: any) {
        discoveryEngine.addLog('SYSTEM', 'error', `Error syncing audio properties: ${err.message}`);
      }
    }
  }

  private async stopAndUnloadActiveSound() {
    if (this.activeSound) {
      try {
        const status = await this.activeSound.getStatusAsync();
        if (status.isLoaded) {
          await this.activeSound.stopAsync();
          await this.activeSound.unloadAsync();
        }
      } catch (err: any) {
        discoveryEngine.addLog('SYSTEM', 'error', `Error unloading audio: ${err.message}`);
      } finally {
        this.activeSound = null;
        this.activeUrl = null;
      }
    }
  }

  private notifyListeners() {
    this.listeners.forEach((cb) => cb([...this.speakers]));
    this.syncAudioPlayback();
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
