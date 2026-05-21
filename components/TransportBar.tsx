import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  PanResponder,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Speaker, stateStore, PlayQueueItem } from '../core/stateStore';
import { megaphoneEngine, MegaphoneState } from '../core/megaphone';

interface TransportBarProps {
  selectedSpeaker: Speaker | null;
  allSpeakers: Speaker[];
}

export const TransportBar: React.FC<TransportBarProps> = ({
  selectedSpeaker,
  allSpeakers,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [trackWidth, setTrackWidth] = useState(0);
  const [scrubProgress, setScrubProgress] = useState<number | null>(null);
  const [megaphoneState, setMegaphoneState] = useState<MegaphoneState>('idle');
  const [megaphoneGain, setMegaphoneGain] = useState(100);

  // Subscribe to megaphone engine state
  useEffect(() => {
    const unsub = megaphoneEngine.subscribe(setMegaphoneState);
    return unsub;
  }, []);

  // Sync internal state with active selected speaker (skip when actively scrubbing)
  useEffect(() => {
    if (selectedSpeaker && scrubProgress === null) {
      setIsPlaying(selectedSpeaker.status === 'playing');
      setProgress(selectedSpeaker.currentTrack?.progress || 0);
    }
  }, [selectedSpeaker, selectedSpeaker?.status, selectedSpeaker?.currentTrack?.progress, scrubProgress]);

  // Local ticker for track progress slider (paused while scrubbing)
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (isPlaying && selectedSpeaker?.currentTrack && scrubProgress === null) {
      interval = setInterval(() => {
        setProgress((prev) => {
          const max = selectedSpeaker.currentTrack?.duration || 100;
          if (prev >= max) return 0;
          return prev + 1;
        });
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isPlaying, selectedSpeaker, scrubProgress]);

  if (!selectedSpeaker) {
    return (
      <View style={styles.container}>
        <View style={styles.noSelectionContainer}>
          <Text style={styles.noSelectionText}>
            Select a room to activate global console deck
          </Text>
        </View>
      </View>
    );
  }

  const track = selectedSpeaker.currentTrack;
  const duration = track?.duration || 100;
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Interactive seek/scrub
  const displayProgress = scrubProgress ?? progress;
  const seekableSpeakerId = selectedSpeaker.id;
  const isScrubbable = !!track && selectedSpeaker.status !== 'offline';

  const xToSeconds = (locationX: number): number => {
    if (trackWidth <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, locationX / trackWidth));
    return ratio * duration;
  };

  const seekPanResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => isScrubbable,
    onMoveShouldSetPanResponder: () => isScrubbable,
    onPanResponderGrant: (evt) => {
      setScrubProgress(xToSeconds(evt.nativeEvent.locationX));
    },
    onPanResponderMove: (evt) => {
      setScrubProgress(xToSeconds(evt.nativeEvent.locationX));
    },
    onPanResponderRelease: (evt) => {
      const seconds = xToSeconds(evt.nativeEvent.locationX);
      stateStore.seekTo(seekableSpeakerId, seconds);
      setProgress(seconds);
      setScrubProgress(null);
    },
    onPanResponderTerminate: () => setScrubProgress(null),
  });

  const handlePlayPause = () => {
    stateStore.togglePlayPause(selectedSpeaker.id);
  };

  const handleSkipNext = () => {
    // Play next song from queue
    const queue = stateStore.getQueue();
    if (queue.length > 0) {
      const nextIndex = Math.floor(Math.random() * queue.length);
      stateStore.playTrackFromQueue(selectedSpeaker.id, queue[nextIndex]);
    }
  };

  const handleSkipPrev = () => {
    // Restart song or select another
    const queue = stateStore.getQueue();
    if (queue.length > 0) {
      stateStore.playTrackFromQueue(selectedSpeaker.id, queue[0]);
    }
  };

  // Adjust master zone volume or single speaker volume
  const adjustVolume = (delta: number) => {
    const nextVolume = Math.min(100, Math.max(0, selectedSpeaker.volume + delta));
    stateStore.setVolume(selectedSpeaker.id, nextVolume);
  };

  return (
    <View style={styles.container}>
      {/* Track Info (Left Pane Segment) */}
      <View style={styles.leftSection}>
        {track ? (
          <View style={styles.trackDetailsCard}>
            <View style={styles.artworkContainer}>
              {track.artwork ? (
                <View
                  style={[
                    styles.artworkPlaceholder,
                    { backgroundColor: '#1e1b4b' },
                  ]}
                >
                  <Ionicons name="musical-notes" size={16} color="#818cf8" />
                </View>
              ) : (
                <View style={styles.artworkPlaceholder}>
                  <Ionicons name="musical-note" size={18} color="#4b5563" />
                </View>
              )}
            </View>
            <View style={styles.trackMetadata}>
              <Text numberOfLines={1} style={styles.trackTitle}>
                {track.title}
              </Text>
              <Text numberOfLines={1} style={styles.trackArtist}>
                {track.artist}
              </Text>
              <Text numberOfLines={1} style={styles.trackLocation}>
                🎙 {selectedSpeaker.name} • {selectedSpeaker.model}
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.idleDetailsCard}>
            <Ionicons name="disc-outline" size={24} color="#4b5563" />
            <Text style={styles.idleTitle}>Select audio source</Text>
          </View>
        )}
      </View>

      {/* Main Transport Deck (Center Pane Segment) */}
      <View style={styles.centerSection}>
        <View style={styles.controlsRow}>
          <TouchableOpacity style={styles.shuffleButton}>
            <Ionicons name="shuffle" size={16} color="#9ca3af" />
          </TouchableOpacity>

          <TouchableOpacity style={styles.seekButton} onPress={handleSkipPrev}>
            <Ionicons name="play-back" size={20} color="#ffffff" />
          </TouchableOpacity>

          <TouchableOpacity style={styles.mainPlayButton} onPress={handlePlayPause}>
            <Ionicons
              name={isPlaying ? 'pause' : 'play'}
              size={24}
              color="#000000"
              style={{ marginLeft: isPlaying ? 0 : 2 }}
            />
          </TouchableOpacity>

          <TouchableOpacity style={styles.seekButton} onPress={handleSkipNext}>
            <Ionicons name="play-forward" size={20} color="#ffffff" />
          </TouchableOpacity>

          <TouchableOpacity style={styles.repeatButton}>
            <Ionicons name="repeat" size={16} color="#9ca3af" />
          </TouchableOpacity>
        </View>

        {/* Global Track Progress Scrub Bar (interactive) */}
        <View style={styles.progressContainer}>
          <Text style={[styles.timeLabel, scrubProgress !== null && styles.timeLabelScrubbing]}>
            {formatTime(displayProgress)}
          </Text>
          <View
            style={styles.progressBarTrack}
            onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
            {...seekPanResponder.panHandlers}
            accessibilityRole="adjustable"
            accessibilityLabel="Seek track position"
            accessibilityValue={{ now: Math.round(displayProgress), min: 0, max: Math.round(duration) }}
          >
            <View
              style={[
                styles.progressBarFill,
                scrubProgress !== null && styles.progressBarFillScrubbing,
                { width: `${(displayProgress / duration) * 100}%` },
              ]}
            />
            {isScrubbable && trackWidth > 0 && (
              <View
                style={[
                  styles.scrubKnob,
                  scrubProgress !== null && styles.scrubKnobActive,
                  { left: `${(displayProgress / duration) * 100}%` },
                ]}
              />
            )}
          </View>
          <Text style={styles.timeLabel}>{formatTime(duration)}</Text>
        </View>
      </View>

      {/* Console Master Deck (Right Pane Segment) */}
      <View style={styles.rightSection}>
        <View style={styles.masterVolumeSection}>
          <TouchableOpacity
            style={[styles.volumeMuteBtn, selectedSpeaker.muted && styles.volumeMuteBtnActive]}
            onPress={() => stateStore.toggleMute(selectedSpeaker.id)}
            accessibilityRole="button"
            accessibilityLabel={selectedSpeaker.muted ? 'Unmute selected speaker' : 'Mute selected speaker'}
          >
            <Ionicons
              name={selectedSpeaker.muted ? 'volume-mute' : 'volume-high'}
              size={18}
              color={selectedSpeaker.muted ? '#f87171' : '#9ca3af'}
            />
          </TouchableOpacity>

          <TouchableOpacity style={styles.volumeAdjustBtn} onPress={() => adjustVolume(-5)}>
            <Ionicons name="remove" size={16} color="#ffffff" />
          </TouchableOpacity>

          <View style={styles.volumeIndicatorTrack}>
            <View style={[styles.volumeIndicatorFill, { width: `${selectedSpeaker.volume}%` }]} />
            <Text style={styles.volumeValueLabel}>{selectedSpeaker.volume}%</Text>
          </View>

          <TouchableOpacity style={styles.volumeAdjustBtn} onPress={() => adjustVolume(5)}>
            <Ionicons name="add" size={16} color="#ffffff" />
          </TouchableOpacity>
        </View>

        {/* Global Group Quick Actions */}
        <View style={styles.quickActionsGroup}>
          <TouchableOpacity
            style={styles.actionBadge}
            onPress={async () => {
              // Group all active online speakers together with selectedSpeaker
              const master = selectedSpeaker;
              const onlineSlaves = allSpeakers.filter(
                (s) => s.id !== master.id && s.status !== 'offline'
              );
              for (const slave of onlineSlaves) {
                await stateStore.groupSpeakers(master.id, slave.id);
              }
            }}
          >
            <Ionicons name="people" size={12} color="#a5b4fc" />
            <Text style={styles.actionBadgeText}>Group All</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBadge, styles.dangerBadge]}
            onPress={async () => {
              // Separate all speakers
              for (const s of allSpeakers) {
                if (s.zoneId) {
                  await stateStore.ungroupSpeaker(s.id);
                }
              }
            }}
          >
            <Ionicons name="close-circle" size={12} color="#fca5a5" />
            <Text style={[styles.actionBadgeText, { color: '#fca5a5' }]}>Ungroup All</Text>
          </TouchableOpacity>

          {/* Megaphone Toggle */}
          <TouchableOpacity
            style={[
              styles.actionBadge,
              megaphoneState === 'live' && styles.megaphoneBadgeLive,
              megaphoneState === 'requesting' && styles.megaphoneBadgeRequesting,
              { marginLeft: 6, marginRight: 0 },
            ]}
            onPress={() => megaphoneEngine.toggle()}
            accessibilityRole="button"
            accessibilityLabel={megaphoneState === 'live' ? 'Turn off megaphone' : 'Turn on megaphone'}
          >
            <Ionicons
              name="mic"
              size={12}
              color={megaphoneState === 'live' ? '#ffffff' : '#c084fc'}
            />
            <Text
              style={[
                styles.actionBadgeText,
                { color: megaphoneState === 'live' ? '#ffffff' : '#c084fc' },
              ]}
            >
              {megaphoneState === 'live' ? 'MIC LIVE' : megaphoneState === 'requesting' ? 'MIC...' : 'Megaphone'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Megaphone Gain Slider — visible only when live */}
        {megaphoneState === 'live' && (
          <View style={styles.megaphoneGainRow}>
            <Ionicons name="mic" size={10} color="#ef4444" />
            <TouchableOpacity
              style={styles.megaphoneGainBtn}
              onPress={() => {
                const next = Math.max(0, megaphoneGain - 10);
                setMegaphoneGain(next);
                megaphoneEngine.setGain(next / 100);
              }}
            >
              <Ionicons name="remove" size={10} color="#ffffff" />
            </TouchableOpacity>
            <View style={styles.megaphoneGainTrack}>
              <View style={[styles.megaphoneGainFill, { width: `${megaphoneGain}%` }]} />
            </View>
            <TouchableOpacity
              style={styles.megaphoneGainBtn}
              onPress={() => {
                const next = Math.min(100, megaphoneGain + 10);
                setMegaphoneGain(next);
                megaphoneEngine.setGain(next / 100);
              }}
            >
              <Ionicons name="add" size={10} color="#ffffff" />
            </TouchableOpacity>
            <Text style={styles.megaphoneGainLabel}>{megaphoneGain}%</Text>
          </View>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 90,
    backgroundColor: 'rgba(15, 15, 15, 0.95)',
    borderTopWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    justifyContent: 'space-between',
    width: '100%',
  },
  noSelectionContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noSelectionText: {
    color: '#4b5563',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  leftSection: {
    width: '28%',
    justifyContent: 'center',
  },
  trackDetailsCard: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  artworkContainer: {
    width: 48,
    height: 48,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#1f2937',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  artworkPlaceholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  trackMetadata: {
    marginLeft: 12,
    flex: 1,
  },
  trackTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  trackArtist: {
    color: '#9ca3af',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2,
  },
  trackLocation: {
    color: '#6366f1',
    fontSize: 9,
    fontWeight: '600',
    marginTop: 3,
  },
  idleDetailsCard: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  idleTitle: {
    color: '#6b7280',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 10,
  },
  centerSection: {
    width: '40%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  mainPlayButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 16,
    shadowColor: '#ffffff',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 5,
  },
  seekButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  shuffleButton: {
    marginRight: 10,
  },
  repeatButton: {
    marginLeft: 10,
  },
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
  },
  timeLabel: {
    color: '#4b5563',
    fontSize: 10,
    fontWeight: '700',
    width: 32,
    textAlign: 'center',
  },
  progressBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: '#1e293b',
    borderRadius: 4,
    marginHorizontal: 8,
    position: 'relative',
    justifyContent: 'center',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 4,
  },
  progressBarFillScrubbing: {
    backgroundColor: '#818cf8',
  },
  timeLabelScrubbing: {
    color: '#a5b4fc',
  },
  scrubKnob: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ffffff',
    top: -3,
    marginLeft: -7,
    borderWidth: 1,
    borderColor: '#a5b4fc',
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 4,
  },
  scrubKnobActive: {
    width: 18,
    height: 18,
    borderRadius: 9,
    top: -5,
    marginLeft: -9,
    backgroundColor: '#a5b4fc',
  },
  rightSection: {
    width: '28%',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  masterVolumeSection: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    justifyContent: 'flex-end',
    marginBottom: 8,
  },
  volumeMuteBtn: {
    marginRight: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  volumeMuteBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 0.5,
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  volumeAdjustBtn: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#1f2937',
    borderWidth: 0.5,
    borderColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
  },
  volumeIndicatorTrack: {
    flex: 0.7,
    height: 6,
    backgroundColor: '#111827',
    borderRadius: 3,
    marginHorizontal: 8,
    position: 'relative',
    overflow: 'hidden',
  },
  volumeIndicatorFill: {
    height: '100%',
    backgroundColor: '#6366f1',
    borderRadius: 3,
  },
  volumeValueLabel: {
    position: 'absolute',
    right: 6,
    top: -2,
    color: 'rgba(255, 255, 255, 0.4)',
    fontSize: 7,
    fontWeight: '800',
  },
  quickActionsGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: 'rgba(99, 102, 241, 0.25)',
    marginRight: 6,
  },
  dangerBadge: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderColor: 'rgba(239, 68, 68, 0.25)',
    marginRight: 0,
  },
  megaphoneBadgeLive: {
    backgroundColor: 'rgba(239, 68, 68, 0.35)',
    borderColor: 'rgba(239, 68, 68, 0.6)',
  },
  megaphoneBadgeRequesting: {
    backgroundColor: 'rgba(192, 132, 252, 0.2)',
    borderColor: 'rgba(192, 132, 252, 0.4)',
  },
  actionBadgeText: {
    color: '#a5b4fc',
    fontSize: 9,
    fontWeight: 'bold',
    marginLeft: 4,
  },
  megaphoneGainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  megaphoneGainBtn: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#1f2937',
    borderWidth: 0.5,
    borderColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 3,
  },
  megaphoneGainTrack: {
    width: 60,
    height: 4,
    backgroundColor: '#1e293b',
    borderRadius: 2,
    overflow: 'hidden',
  },
  megaphoneGainFill: {
    height: '100%',
    backgroundColor: '#ef4444',
    borderRadius: 2,
  },
  megaphoneGainLabel: {
    color: '#ef4444',
    fontSize: 8,
    fontWeight: '800',
    marginLeft: 4,
  },
});
