/**
 * Megaphone Module
 *
 * Captures the device microphone via the Web Audio API and routes
 * it directly to the device speakers in real-time, turning the
 * computer / phone into a live megaphone / PA system.
 *
 * Architecture:
 *   getUserMedia → MediaStreamSource → GainNode → AudioContext.destination
 *
 * The gain node is exposed so that the UI volume fader can scale
 * the megaphone output level independently.
 */

import { discoveryEngine } from './discovery';

export type MegaphoneState = 'idle' | 'requesting' | 'live' | 'error';

type MegaphoneListener = (state: MegaphoneState) => void;

class MegaphoneEngine {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;

  private state: MegaphoneState = 'idle';
  private listeners: MegaphoneListener[] = [];
  private gain: number = 1.0; // 0.0 – 1.0

  getState(): MegaphoneState {
    return this.state;
  }

  getGain(): number {
    return this.gain;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(cb: MegaphoneListener): () => void {
    this.listeners.push(cb);
    cb(this.state);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private setState(next: MegaphoneState) {
    this.state = next;
    this.listeners.forEach((cb) => cb(next));
  }

  /** Adjust the live microphone gain without tearing down the stream. */
  setGain(value: number) {
    this.gain = Math.max(0, Math.min(1, value));
    if (this.gainNode) {
      this.gainNode.gain.value = this.gain;
    }
  }

  /** Start capturing the mic and routing it to speakers. */
  async start(): Promise<void> {
    if (this.state === 'live' || this.state === 'requesting') return;

    this.setState('requesting');
    discoveryEngine.addLog('SYSTEM', 'info', '🎙️ Megaphone: Requesting microphone access...');

    try {
      // Check for browser support
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('getUserMedia is not supported in this environment.');
      }

      // Request the mic
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      // Build the Web Audio graph
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.gain;

      // Wire: mic → gain → speakers
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);

      this.setState('live');
      discoveryEngine.addLog(
        'SYSTEM',
        'success',
        `🎙️ Megaphone LIVE — routing mic to device speakers (gain: ${(this.gain * 100).toFixed(0)}%). Speak now!`,
      );
    } catch (err: any) {
      this.teardown();
      this.setState('error');
      discoveryEngine.addLog(
        'SYSTEM',
        'error',
        `🎙️ Megaphone error: ${err?.message || 'Microphone access denied.'}`,
      );
    }
  }

  /** Stop the megaphone and release all resources. */
  stop() {
    if (this.state === 'idle') return;
    this.teardown();
    this.setState('idle');
    discoveryEngine.addLog('SYSTEM', 'info', '🎙️ Megaphone OFF — mic released.');
  }

  /** Toggle between live / idle. */
  async toggle() {
    if (this.state === 'live') {
      this.stop();
    } else {
      await this.start();
    }
  }

  private teardown() {
    try {
      this.sourceNode?.disconnect();
      this.gainNode?.disconnect();
    } catch { /* already disconnected */ }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }

    this.sourceNode = null;
    this.gainNode = null;
    this.audioContext = null;
    this.mediaStream = null;
  }
}

/** Singleton megaphone engine shared across the app. */
export const megaphoneEngine = new MegaphoneEngine();
