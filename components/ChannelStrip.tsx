import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  PanResponder,
  Animated,
  Dimensions,
  Modal,
  Switch,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Speaker, stateStore, SpeakerEQ, DEFAULT_EQ } from '../core/stateStore';

interface ChannelStripProps {
  speaker: Speaker;
  allSpeakers: Speaker[];
  onDragStart: (speakerId: string, pageX: number, pageY: number) => void;
  onDragMove: (pageX: number, pageY: number) => void;
  onDragEnd: (pageX: number, pageY: number) => void;
  cardRefs: React.MutableRefObject<Record<string, { x: number; y: number; width: number; height: number }>>;
}

export const ChannelStrip: React.FC<ChannelStripProps> = ({
  speaker,
  allSpeakers,
  onDragStart,
  onDragMove,
  onDragEnd,
  cardRefs,
}) => {
  const containerRef = useRef<View>(null);
  const [faderHeight, setFaderHeight] = useState(180);
  const [dragVolume, setDragVolume] = useState<number | null>(null);

  // EQ modal state
  const [showEQ, setShowEQ] = useState(false);
  const liveEQ: SpeakerEQ = speaker.eq ?? DEFAULT_EQ;

  // Animation for pulsing fader track when pending network confirmation
  const pulseAnim = useRef(new Animated.Value(0.4)).current;

  const isOffline = speaker.status === 'offline';
  const isUncalibrated = speaker.isUncalibrated;
  const isMuted = speaker.muted ?? false;
  
  // Is the fader waiting for hardware sync?
  // We read this directly from the LocalFirstSyncEngine in the global store.
  const syncState = stateStore.getSyncState(speaker.id);
  const isPending = syncState ? syncState.syncState === 'PENDING' : false;

  // Track calibration status change to trigger haptic-like scaling animations
  useEffect(() => {
    if (isPending) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.0,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 0.4,
            duration: 400,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1.0);
    }
  }, [isPending]);

  // Measure card coordinates for drag-and-drop grouping collision check
  const handleLayout = () => {
    if (containerRef.current) {
      containerRef.current.measure((fx, fy, width, height, px, py) => {
        cardRefs.current[speaker.id] = { x: px, y: py, width, height };
      });
    }
  };

  // Custom PanResponder for the Vertical Fader
  const faderPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !isOffline,
      onMoveShouldSetPanResponder: () => !isOffline,
      onPanResponderGrant: (evt, gestureState) => {
        // Find click offset inside the track
        updateVolumeFromGesture(evt.nativeEvent.locationY);
      },
      onPanResponderMove: (evt, gestureState) => {
        // Calculate new volume from drag position
        updateVolumeFromGesture(evt.nativeEvent.locationY);
      },
      onPanResponderRelease: (evt, gestureState) => {
        // Finalize volume mutation in state manager
        if (dragVolume !== null) {
          stateStore.setVolume(speaker.id, dragVolume);
          // Let dragVolume linger for 200ms to show the pulse validation in action
          setTimeout(() => {
            setDragVolume(null);
          }, 200);
        }
      },
    })
  ).current;

  const updateVolumeFromGesture = (locationY: number) => {
    // bound locationY to fader height
    const clampedY = Math.max(0, Math.min(faderHeight, locationY));
    // calculate volume percentage (bottom of fader is 100%, top is 0%, wait!
    // Normally, top of container is 0, which corresponds to 100% volume.
    // Bottom of container is faderHeight, which corresponds to 0% volume.
    const percentage = Math.round(((faderHeight - clampedY) / faderHeight) * 100);
    setDragVolume(percentage);
  };

  // PanResponder for drag-grouping handle
  const groupPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !isOffline,
      onMoveShouldSetPanResponder: () => !isOffline,
      onPanResponderGrant: (evt, gestureState) => {
        onDragStart(speaker.id, evt.nativeEvent.pageX, evt.nativeEvent.pageY);
      },
      onPanResponderMove: (evt, gestureState) => {
        onDragMove(gestureState.moveX, gestureState.moveY);
      },
      onPanResponderRelease: (evt, gestureState) => {
        onDragEnd(gestureState.moveX, gestureState.moveY);
      },
    })
  ).current;

  // Use either the real time dragVolume or speaker's true volume
  const currentVolume = dragVolume !== null ? dragVolume : speaker.volume;
  const hardwareVolume = speaker.volume;

  // Group status helper
  const isInZone = speaker.zoneId !== null;
  const zoneInfo = isInZone ? allSpeakers.filter((s) => s.zoneId === speaker.zoneId) : [];
  const otherZoneMembers = zoneInfo.filter((s) => s.id !== speaker.id);

  return (
    <View
      ref={containerRef}
      onLayout={handleLayout}
      style={[
        styles.cardContainer,
        isOffline && styles.cardOffline,
        isUncalibrated && styles.cardUncalibrated,
      ]}
    >
      {/* Header Info */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View
            style={[
              styles.statusDot,
              isOffline
                ? styles.statusOffline
                : isUncalibrated
                ? styles.statusWarning
                : styles.statusOnline,
            ]}
          />
          {speaker.pathway === 'cloud' && (
            <Ionicons name="cloud-outline" size={12} color="#818cf8" style={{ marginRight: 4 }} />
          )}
          <Text numberOfLines={1} style={styles.roomName}>
            {speaker.name}
          </Text>
        </View>
        <Text style={styles.modelName}>{speaker.model}</Text>
      </View>

      {/* Zone Grouping Indicator/Connector */}
      {isInZone && (
        <View style={styles.zoneConnectorBadge}>
          <Ionicons name="link" size={10} color="#6366f1" />
          <Text style={styles.zoneConnectorText}>
            Zone ({zoneInfo.length} rooms)
          </Text>
        </View>
      )}

      {/* Main Fader Channel Strip Area */}
      <View style={styles.faderContainer}>
        {isOffline ? (
          <View style={styles.offlinePlaceholder}>
            <MaterialCommunityIcons name="wifi-strength-1-alert" size={32} color="#4b5563" />
            <Text style={styles.offlineText}>OFFLINE</Text>
          </View>
        ) : (
          <View style={styles.interactiveFaderArea}>
            {/* Decibel Markings (Sleek Mixer Aesthetic) */}
            <View style={styles.decibelScale}>
              <Text style={styles.dbTick}>+10</Text>
              <Text style={styles.dbTick}>0</Text>
              <Text style={styles.dbTick}>-10</Text>
              <Text style={styles.dbTick}>-20</Text>
              <Text style={styles.dbTick}>-40</Text>
              <Text style={styles.dbTick}>-∞</Text>
            </View>

            {/* Vertical Fader Track */}
            <View
              style={styles.faderTrackWrapper}
              onLayout={(e) => setFaderHeight(e.nativeEvent.layout.height)}
              {...faderPanResponder.panHandlers}
            >
              {/* Ghost volume track (updates instantly based on user drag) */}
              {dragVolume !== null && (
                <View
                  style={[
                    styles.ghostVolumeTrack,
                    { height: `${dragVolume}%` },
                  ]}
                />
              )}

              {/* Hardware confirmed volume level track */}
              <Animated.View
                style={[
                  styles.hardwareVolumeTrack,
                  isMuted && styles.hardwareVolumeTrackMuted,
                  {
                    height: `${hardwareVolume}%`,
                    opacity: isPending ? pulseAnim : isMuted ? 0.35 : 1,
                  },
                ]}
              />

              {/* Glowing Pulse Fader Track for pending verification */}
              {isPending && (
                <Animated.View
                  style={[
                    styles.pulseOverlay,
                    {
                      height: `${currentVolume}%`,
                      opacity: pulseAnim,
                    },
                  ]}
                />
              )}

              {/* Tactile Metal Knob / Slider Handle */}
              <View
                style={[
                  styles.faderKnob,
                  { bottom: `${currentVolume}%`, marginBottom: -15 }, // offset half height
                ]}
              >
                <View style={styles.knobInnerLine} />
              </View>
            </View>
          </View>
        )}
      </View>

      {/* Volume Value indicator */}
      {!isOffline && (
        <View style={styles.volumeValueRow}>
          <TouchableOpacity
            onPress={() => stateStore.toggleMute(speaker.id)}
            style={[styles.iconChipBtn, isMuted && styles.iconChipBtnActive]}
            accessibilityRole="button"
            accessibilityLabel={isMuted ? `Unmute ${speaker.name}` : `Mute ${speaker.name}`}
          >
            <Ionicons
              name={isMuted ? 'volume-mute' : 'volume-medium'}
              size={11}
              color={isMuted ? '#f87171' : '#9ca3af'}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowEQ(true)}
            style={styles.iconChipBtn}
            accessibilityRole="button"
            accessibilityLabel={`Open EQ for ${speaker.name}`}
          >
            <MaterialCommunityIcons name="equalizer" size={11} color="#a5b4fc" />
          </TouchableOpacity>
          {isUncalibrated && (
            <TouchableOpacity
              onPress={() => stateStore.calibrateSpeaker(speaker.id)}
              style={styles.calibrateButton}
            >
              <Ionicons name="sync" size={11} color="#f59e0b" />
              <Text style={styles.calibrateText}>Cal</Text>
            </TouchableOpacity>
          )}
          <Text style={[styles.volumePercentage, isMuted && styles.volumePercentageMuted]}>
            {isMuted ? 'MUTED' : isPending ? `⏱ ${currentVolume}%` : `${currentVolume}%`}
          </Text>
        </View>
      )}

      {/* Metadata / Track Info */}
      <View style={styles.trackInfoContainer}>
        {speaker.currentTrack ? (
          <>
            <Text numberOfLines={1} style={styles.trackTitle}>
              {speaker.currentTrack.title}
            </Text>
            <Text numberOfLines={1} style={styles.trackArtist}>
              {speaker.currentTrack.artist}
            </Text>
            {/* Tiny mini-progress bar */}
            <View style={styles.miniProgressTrack}>
              <View
                style={[
                  styles.miniProgressFill,
                  {
                    width: `${
                      (speaker.currentTrack.progress /
                        speaker.currentTrack.duration) *
                      100
                    }%`,
                  },
                ]}
              />
            </View>
          </>
        ) : (
          <Text style={styles.idleText}>Idle</Text>
        )}
      </View>

      {/* Footer controls: Play/Pause and Group Drag Handle */}
      <View style={styles.footerRow}>
        {!isOffline ? (
          <TouchableOpacity
            style={styles.playButton}
            onPress={() => stateStore.togglePlayPause(speaker.id)}
          >
            <Ionicons
              name={speaker.status === 'playing' ? 'pause' : 'play'}
              size={18}
              color="#ffffff"
            />
          </TouchableOpacity>
        ) : (
          <View style={styles.disabledPlayButton}>
            <Ionicons name="volume-mute" size={18} color="#4b5563" />
          </View>
        )}

        {/* Drag handle to group */}
        {!isOffline ? (
          <View style={styles.groupDragHandle} {...groupPanResponder.panHandlers}>
            <MaterialCommunityIcons name="drag-vertical" size={20} color="#818cf8" />
            <Text style={styles.groupDragText}>ZONE</Text>
          </View>
        ) : (
          <View style={styles.groupDragHandleDisabled}>
            <MaterialCommunityIcons name="drag-vertical" size={20} color="#4b5563" />
            <Text style={[styles.groupDragText, { color: '#4b5563' }]}>OFF</Text>
          </View>
        )}

        {isInZone && (
          <TouchableOpacity
            style={styles.unlinkButton}
            onPress={() => stateStore.ungroupSpeaker(speaker.id)}
          >
            <MaterialCommunityIcons name="link-off" size={16} color="#ef4444" />
          </TouchableOpacity>
        )}
      </View>

      {/* EQ Settings Modal */}
      <EQModal
        visible={showEQ}
        speaker={speaker}
        initialEQ={liveEQ}
        onClose={() => setShowEQ(false)}
      />
    </View>
  );
};

interface EQModalProps {
  visible: boolean;
  speaker: Speaker;
  initialEQ: SpeakerEQ;
  onClose: () => void;
}

const EQModal: React.FC<EQModalProps> = ({ visible, speaker, initialEQ, onClose }) => {
  const [draft, setDraft] = useState<SpeakerEQ>(initialEQ);

  // Reset draft whenever the modal opens for a different speaker / fresh EQ
  useEffect(() => {
    if (visible) setDraft(initialEQ);
  }, [visible, speaker.id]);

  const commit = (next: SpeakerEQ) => {
    setDraft(next);
    stateStore.setEQ(speaker.id, next);
  };

  const adjustBass = (delta: number) => {
    const bass = Math.max(-10, Math.min(10, draft.bass + delta));
    commit({ ...draft, bass });
  };
  const adjustTreble = (delta: number) => {
    const treble = Math.max(-10, Math.min(10, draft.treble + delta));
    commit({ ...draft, treble });
  };

  const reset = () => commit({ ...DEFAULT_EQ });

  // Visual ticks for the bass/treble scale (-10..+10 in 5 steps)
  const renderScale = (value: number) => {
    const ticks = [-10, -5, 0, 5, 10];
    return (
      <View style={eqStyles.scaleRow}>
        {ticks.map((t) => (
          <View
            key={t}
            style={[
              eqStyles.scaleDot,
              value >= t && t <= 0 && t !== 0 ? eqStyles.scaleDotActiveNeg : null,
              value >= t && t === 0 ? eqStyles.scaleDotActiveZero : null,
              value >= t && t > 0 ? eqStyles.scaleDotActivePos : null,
            ]}
          />
        ))}
      </View>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={eqStyles.backdrop}>
        <View style={eqStyles.card}>
          <View style={eqStyles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={eqStyles.title}>EQ — {speaker.name}</Text>
              <Text style={eqStyles.subtitle}>RenderingControl:1#SetEQ</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={eqStyles.closeBtn}>
              <Ionicons name="close" size={18} color="#e5e7eb" />
            </TouchableOpacity>
          </View>

          {/* Bass */}
          <View style={eqStyles.sliderRow}>
            <View style={eqStyles.sliderLabelCol}>
              <Text style={eqStyles.sliderLabel}>BASS</Text>
              <Text style={eqStyles.sliderValue}>
                {draft.bass > 0 ? `+${draft.bass}` : draft.bass} dB
              </Text>
            </View>
            <View style={eqStyles.sliderStepperCol}>
              <TouchableOpacity style={eqStyles.stepBtn} onPress={() => adjustBass(-1)}>
                <Ionicons name="remove" size={14} color="#ffffff" />
              </TouchableOpacity>
              {renderScale(draft.bass)}
              <TouchableOpacity style={eqStyles.stepBtn} onPress={() => adjustBass(1)}>
                <Ionicons name="add" size={14} color="#ffffff" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Treble */}
          <View style={eqStyles.sliderRow}>
            <View style={eqStyles.sliderLabelCol}>
              <Text style={eqStyles.sliderLabel}>TREBLE</Text>
              <Text style={eqStyles.sliderValue}>
                {draft.treble > 0 ? `+${draft.treble}` : draft.treble} dB
              </Text>
            </View>
            <View style={eqStyles.sliderStepperCol}>
              <TouchableOpacity style={eqStyles.stepBtn} onPress={() => adjustTreble(-1)}>
                <Ionicons name="remove" size={14} color="#ffffff" />
              </TouchableOpacity>
              {renderScale(draft.treble)}
              <TouchableOpacity style={eqStyles.stepBtn} onPress={() => adjustTreble(1)}>
                <Ionicons name="add" size={14} color="#ffffff" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Toggles */}
          <View style={eqStyles.toggleRow}>
            <View style={eqStyles.toggleLabelCol}>
              <Text style={eqStyles.toggleLabel}>Loudness</Text>
              <Text style={eqStyles.toggleHint}>Low-frequency emphasis at low volume</Text>
            </View>
            <Switch
              value={draft.loudness}
              onValueChange={(v) => commit({ ...draft, loudness: v })}
              trackColor={{ false: '#374151', true: '#6366f1' }}
              thumbColor={draft.loudness ? '#a5b4fc' : '#9ca3af'}
            />
          </View>

          <View style={eqStyles.toggleRow}>
            <View style={eqStyles.toggleLabelCol}>
              <Text style={eqStyles.toggleLabel}>Night Mode</Text>
              <Text style={eqStyles.toggleHint}>Compress dynamic range for quiet listening</Text>
            </View>
            <Switch
              value={draft.nightMode}
              onValueChange={(v) => commit({ ...draft, nightMode: v })}
              trackColor={{ false: '#374151', true: '#6366f1' }}
              thumbColor={draft.nightMode ? '#a5b4fc' : '#9ca3af'}
            />
          </View>

          <View style={eqStyles.footerRow}>
            <TouchableOpacity onPress={reset} style={eqStyles.resetBtn}>
              <Ionicons name="refresh" size={12} color="#fbbf24" />
              <Text style={eqStyles.resetText}>Reset to Flat</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={eqStyles.doneBtn}>
              <Text style={eqStyles.doneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  cardContainer: {
    width: 175,
    height: 380,
    backgroundColor: 'rgba(23, 23, 23, 0.85)',
    borderRadius: 16,
    padding: 12,
    marginRight: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  cardOffline: {
    opacity: 0.5,
    borderColor: 'rgba(239, 68, 68, 0.2)',
  },
  cardUncalibrated: {
    borderColor: 'rgba(245, 158, 11, 0.4)',
    borderWidth: 1.5,
  },
  header: {
    marginBottom: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  statusOnline: {
    backgroundColor: '#10b981', // green
  },
  statusWarning: {
    backgroundColor: '#f59e0b', // yellow/orange
  },
  statusOffline: {
    backgroundColor: '#ef4444', // red
  },
  roomName: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
  },
  modelName: {
    color: '#9ca3af',
    fontSize: 10,
    fontWeight: '500',
    paddingLeft: 12,
  },
  zoneConnectorBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 4,
    alignSelf: 'flex-start',
    marginBottom: 6,
  },
  zoneConnectorText: {
    color: '#a5b4fc',
    fontSize: 9,
    fontWeight: '600',
    marginLeft: 4,
  },
  faderContainer: {
    flex: 1,
    marginVertical: 10,
    position: 'relative',
  },
  offlinePlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  offlineText: {
    color: '#6b7280',
    fontSize: 10,
    fontWeight: 'bold',
    marginTop: 6,
    letterSpacing: 1,
  },
  interactiveFaderArea: {
    flex: 1,
    flexDirection: 'row',
  },
  decibelScale: {
    width: 25,
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  dbTick: {
    color: '#4b5563',
    fontSize: 8,
    fontWeight: '600',
    textAlign: 'right',
    paddingRight: 4,
  },
  faderTrackWrapper: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 8,
    position: 'relative',
    overflow: 'visible', // allow handle shadow to bleed
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  ghostVolumeTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(99, 102, 241, 0.35)', // translucent blue
    borderRadius: 7,
  },
  hardwareVolumeTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.85)', // main solid slider track
    borderRadius: 7,
  },
  pulseOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#818cf8', // glowing purple overlay
    borderRadius: 7,
  },
  faderKnob: {
    position: 'absolute',
    left: -4,
    right: -4,
    height: 30,
    borderRadius: 6,
    backgroundColor: '#1f2937',
    borderWidth: 2,
    borderColor: '#e5e7eb',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 3,
    elevation: 3,
  },
  knobInnerLine: {
    width: 14,
    height: 3,
    backgroundColor: '#9ca3af',
    borderRadius: 1.5,
  },
  volumeValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  iconChipBtn: {
    width: 22,
    height: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderRadius: 4,
    borderWidth: 0.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 4,
  },
  iconChipBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  hardwareVolumeTrackMuted: {
    backgroundColor: 'rgba(248, 113, 113, 0.55)',
  },
  volumePercentageMuted: {
    color: '#f87171',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  calibrateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    paddingVertical: 2,
    paddingHorizontal: 5,
    borderRadius: 4,
    borderWidth: 0.5,
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  calibrateText: {
    color: '#f59e0b',
    fontSize: 8,
    fontWeight: 'bold',
    marginLeft: 2,
  },
  volumePercentage: {
    color: '#e5e7eb',
    fontSize: 11,
    fontWeight: '700',
    marginLeft: 'auto',
  },
  trackInfoContainer: {
    backgroundColor: '#111827',
    padding: 8,
    borderRadius: 8,
    height: 52,
    justifyContent: 'center',
    marginBottom: 8,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  trackTitle: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
  trackArtist: {
    color: '#9ca3af',
    fontSize: 8,
    fontWeight: '500',
    marginTop: 1,
  },
  miniProgressTrack: {
    height: 2,
    backgroundColor: '#374151',
    borderRadius: 1,
    marginTop: 4,
    width: '100%',
  },
  miniProgressFill: {
    height: '100%',
    backgroundColor: '#6366f1',
    borderRadius: 1,
  },
  idleText: {
    color: '#4b5563',
    fontSize: 10,
    fontWeight: '500',
    textAlign: 'center',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  playButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#312e81',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#4338ca',
  },
  disabledPlayButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1f2937',
    justifyContent: 'center',
    alignItems: 'center',
  },
  groupDragHandle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 32,
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.25)',
    borderRadius: 8,
    marginLeft: 8,
  },
  groupDragHandleDisabled: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 32,
    backgroundColor: '#1f2937',
    borderRadius: 8,
    marginLeft: 8,
  },
  groupDragText: {
    color: '#818cf8',
    fontSize: 9,
    fontWeight: 'bold',
    marginLeft: 2,
    letterSpacing: 0.5,
  },
  unlinkButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
});

const eqStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: 360,
    maxWidth: '100%',
    backgroundColor: '#0f172a',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.25)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.6,
    shadowRadius: 24,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  subtitle: {
    color: '#6366f1',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 2,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.05)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRadius: 10,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.04)',
  },
  sliderLabelCol: {
    width: 72,
  },
  sliderLabel: {
    color: '#a5b4fc',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  sliderValue: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 2,
  },
  sliderStepperCol: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#1f2937',
    borderWidth: 0.5,
    borderColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
  },
  scaleRow: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginHorizontal: 8,
  },
  scaleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#1f2937',
  },
  scaleDotActiveNeg: {
    backgroundColor: '#3b82f6',
  },
  scaleDotActiveZero: {
    backgroundColor: '#e5e7eb',
  },
  scaleDotActivePos: {
    backgroundColor: '#f59e0b',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRadius: 10,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.04)',
    marginBottom: 10,
  },
  toggleLabelCol: {
    flex: 1,
  },
  toggleLabel: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  toggleHint: {
    color: '#6b7280',
    fontSize: 9,
    fontWeight: '500',
    marginTop: 2,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
    borderWidth: 0.5,
    borderColor: 'rgba(251, 191, 36, 0.3)',
  },
  resetText: {
    color: '#fbbf24',
    fontSize: 10,
    fontWeight: '700',
    marginLeft: 4,
  },
  doneBtn: {
    paddingVertical: 8,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#6366f1',
  },
  doneText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
});
