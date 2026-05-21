export interface SpeakerVolumeState {
  playerId: string;
  confirmedVolume: number;
  optimisticVolume: number;
  syncState: 'DRAFT' | 'PENDING' | 'CONFIRMED';
  lastLocalWriteTime: number;
  lastSequenceId: number;
  pendingCorrelationId: string | null;
}

export class LocalFirstSyncEngine {
  private state: SpeakerVolumeState;
  private readonly LOCKOUT_WINDOW_MS = 800;

  constructor(initialPlayerId: string, initialVolume: number) {
    this.state = {
      playerId: initialPlayerId,
      confirmedVolume: initialVolume,
      optimisticVolume: initialVolume,
      syncState: 'CONFIRMED',
      lastLocalWriteTime: 0,
      lastSequenceId: 0,
      pendingCorrelationId: null,
    };
  }

  /**
   * Retrieves the volume that should currently be rendered on the UI slider.
   * If PENDING, returns the user's optimistic gesture volume.
   * If CONFIRMED, returns the actual verified hardware volume.
   */
  public getDisplayVolume(): number {
    if (this.state.syncState === 'PENDING') {
      return this.state.optimisticVolume;
    }
    return this.state.confirmedVolume;
  }

  /**
   * Checks if the slider is currently in an optimistic state waiting for validation.
   */
  public isOptimisticPending(): boolean {
    return this.state.syncState === 'PENDING';
  }

  /**
   * Registers a user touch/drag gesture on the volume slider.
   * Updates state to PENDING and starts the lockout temporal window.
   */
  public registerUserInteraction(targetVolume: number, correlationId: string): void {
    const epochTimeNow = Date.now();
    this.state.optimisticVolume = targetVolume;
    this.state.syncState = 'PENDING';
    this.state.lastLocalWriteTime = epochTimeNow;
    this.state.pendingCorrelationId = correlationId;
  }

  /**
   * Reconciles incoming hardware network events with the local state.
   * Employs passive synchronization, correlation checks, and lockout expiry bounds.
   */
  public receiveHardwareUpdate(
    reportedVolume: number,
    sequenceId: number,
    correlationId: string | null
  ): void {
    const epochTimeNow = Date.now();

    if (this.state.syncState === 'PENDING') {
      const isMatchingCorrelation =
        correlationId !== null &&
        this.state.pendingCorrelationId === correlationId;

      const windowHasExpired =
        epochTimeNow - this.state.lastLocalWriteTime >= this.LOCKOUT_WINDOW_MS;

      // Transition back to CONFIRMED if correlation matches OR if the lockout has expired
      if (isMatchingCorrelation || windowHasExpired) {
        this.state.confirmedVolume = reportedVolume;
        this.state.syncState = 'CONFIRMED';
        this.state.pendingCorrelationId = null;
        this.state.lastSequenceId = sequenceId;
      }
    } else {
      // Passive sync: accept any hardware update with a newer or equal sequence identifier
      if (sequenceId >= this.state.lastSequenceId) {
        this.state.confirmedVolume = reportedVolume;
        this.state.lastSequenceId = sequenceId;
      }
    }
  }

  /**
   * Returns a copy of the internal synchronization state tree for visual debugging.
   */
  public getRawState(): Readonly<SpeakerVolumeState> {
    return { ...this.state };
  }
}
