import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  TouchableOpacity,
  PanResponder,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Speaker, stateStore, PlayQueueItem } from '../core/stateStore';

interface TurntableProps {
  selectedSpeaker: Speaker | null;
}

export const Turntable: React.FC<TurntableProps> = ({ selectedSpeaker }) => {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const spinLoop = useRef<Animated.CompositeAnimation | null>(null);
  const [isScratching, setIsScratching] = useState(false);
  const [scratchAngle, setScratchAngle] = useState(0);
  const [pitchRate, setPitchRate] = useState(100); // 100 = normal speed
  const [queue, setQueue] = useState<PlayQueueItem[]>([]);

  const isPlaying = selectedSpeaker?.status === 'playing';
  const track = selectedSpeaker?.currentTrack;

  // Subscribe to queue
  useEffect(() => {
    const unsub = stateStore.subscribeQueue(setQueue);
    return unsub;
  }, []);

  // Spin the platter while playing
  useEffect(() => {
    if (isPlaying && !isScratching) {
      spinAnim.setValue(0);
      spinLoop.current = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: (3000 / pitchRate) * 100, // slower at low pitch, faster at high
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );
      spinLoop.current.start();
    } else {
      spinLoop.current?.stop();
    }

    return () => {
      spinLoop.current?.stop();
    };
  }, [isPlaying, isScratching, pitchRate]);

  const spinInterpolation = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Scratch PanResponder — drag on the vinyl to scrub
  const lastY = useRef(0);
  const scratchPanResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => !!track,
    onMoveShouldSetPanResponder: () => !!track,
    onPanResponderGrant: () => {
      setIsScratching(true);
      lastY.current = 0;
    },
    onPanResponderMove: (_evt, gestureState) => {
      const delta = gestureState.dy - lastY.current;
      lastY.current = gestureState.dy;
      setScratchAngle((prev) => prev + delta * 2);

      // Seek proportionally
      if (selectedSpeaker && track) {
        const seekDelta = delta * 0.3; // ~0.3s per pixel
        const newProgress = Math.max(
          0,
          Math.min(track.duration, (track.progress || 0) + seekDelta)
        );
        stateStore.seekTo(selectedSpeaker.id, newProgress);
      }
    },
    onPanResponderRelease: () => {
      setIsScratching(false);
    },
    onPanResponderTerminate: () => {
      setIsScratching(false);
    },
  });

  const handlePlayPause = () => {
    if (selectedSpeaker) {
      stateStore.togglePlayPause(selectedSpeaker.id);
    }
  };

  const handleLoadTrack = (t: PlayQueueItem) => {
    if (selectedSpeaker) {
      stateStore.playTrackFromQueue(selectedSpeaker.id, t);
    }
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <View style={styles.container}>
      <Text style={styles.deckLabel}>DECK A</Text>

      {/* ---- The Platter ---- */}
      <View style={styles.platterOuter}>
        {/* Slipmat ring */}
        <View style={styles.slipmat} />

        <Animated.View
          style={[
            styles.platter,
            {
              transform: [
                {
                  rotate: isScratching
                    ? `${scratchAngle}deg`
                    : spinInterpolation,
                },
              ],
            },
          ]}
          {...scratchPanResponder.panHandlers}
        >
          {/* Grooves */}
          <View style={styles.groove1} />
          <View style={styles.groove2} />
          <View style={styles.groove3} />

          {/* Center Label */}
          <View style={styles.centerLabel}>
            <View style={styles.centerHole} />
            {track ? (
              <>
                <Text numberOfLines={1} style={styles.labelTitle}>
                  {track.title}
                </Text>
                <Text numberOfLines={1} style={styles.labelArtist}>
                  {track.artist}
                </Text>
              </>
            ) : (
              <Text style={styles.labelIdle}>NO DISC</Text>
            )}
          </View>
        </Animated.View>

        {/* Tonearm */}
        <View
          style={[
            styles.tonearm,
            isPlaying && styles.tonearmPlaying,
          ]}
        />
        <View
          style={[
            styles.tonearmHead,
            isPlaying && styles.tonearmHeadPlaying,
          ]}
        />

        {/* Scratch indicator */}
        {isScratching && (
          <View style={styles.scratchIndicator}>
            <Text style={styles.scratchText}>SCRATCH</Text>
          </View>
        )}
      </View>

      {/* ---- Transport Controls ---- */}
      <View style={styles.controlsRow}>
        <TouchableOpacity style={styles.controlBtn} onPress={handlePlayPause}>
          <Ionicons
            name={isPlaying ? 'pause' : 'play'}
            size={22}
            color="#ffffff"
          />
        </TouchableOpacity>

        <View style={styles.pitchSection}>
          <Text style={styles.pitchLabel}>PITCH</Text>
          <View style={styles.pitchTrack}>
            <View
              style={[
                styles.pitchFill,
                { height: `${pitchRate}%` },
              ]}
            />
          </View>
          <View style={styles.pitchBtns}>
            <TouchableOpacity
              style={styles.pitchBtn}
              onPress={() => setPitchRate((p) => Math.min(150, p + 5))}
            >
              <Ionicons name="add" size={10} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.pitchValue}>{pitchRate}%</Text>
            <TouchableOpacity
              style={styles.pitchBtn}
              onPress={() => setPitchRate((p) => Math.max(50, p - 5))}
            >
              <Ionicons name="remove" size={10} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* ---- Track Progress ---- */}
      {track && (
        <View style={styles.progressRow}>
          <Text style={styles.progressTime}>
            {formatTime(track.progress || 0)}
          </Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${((track.progress || 0) / track.duration) * 100}%`,
                },
              ]}
            />
          </View>
          <Text style={styles.progressTime}>
            {formatTime(track.duration)}
          </Text>
        </View>
      )}

      {/* ---- Quick-Load from Queue ---- */}
      <Text style={styles.crateLabel}>CRATE</Text>
      <View style={styles.crateList}>
        {queue.slice(0, 5).map((t) => (
          <TouchableOpacity
            key={t.id}
            style={[
              styles.crateItem,
              track?.title === t.title && styles.crateItemActive,
            ]}
            onPress={() => handleLoadTrack(t)}
          >
            <Ionicons name="disc" size={10} color="#818cf8" />
            <Text numberOfLines={1} style={styles.crateTitle}>
              {t.title}
            </Text>
            <Text style={styles.crateDur}>
              {formatTime(t.duration)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
};

const PLATTER_SIZE = 180;
const CENTER_SIZE = 60;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 8,
    paddingHorizontal: 8,
  },
  deckLabel: {
    color: '#6366f1',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 3,
    marginBottom: 8,
  },

  // ---- Platter ----
  platterOuter: {
    width: PLATTER_SIZE + 20,
    height: PLATTER_SIZE + 20,
    borderRadius: (PLATTER_SIZE + 20) / 2,
    backgroundColor: '#0d0d0d',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#1f2937',
    position: 'relative',
  },
  slipmat: {
    position: 'absolute',
    width: PLATTER_SIZE + 10,
    height: PLATTER_SIZE + 10,
    borderRadius: (PLATTER_SIZE + 10) / 2,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.15)',
  },
  platter: {
    width: PLATTER_SIZE,
    height: PLATTER_SIZE,
    borderRadius: PLATTER_SIZE / 2,
    backgroundColor: '#111111',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#222',
  },
  groove1: {
    position: 'absolute',
    width: PLATTER_SIZE - 20,
    height: PLATTER_SIZE - 20,
    borderRadius: (PLATTER_SIZE - 20) / 2,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.04)',
  },
  groove2: {
    position: 'absolute',
    width: PLATTER_SIZE - 50,
    height: PLATTER_SIZE - 50,
    borderRadius: (PLATTER_SIZE - 50) / 2,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  groove3: {
    position: 'absolute',
    width: PLATTER_SIZE - 80,
    height: PLATTER_SIZE - 80,
    borderRadius: (PLATTER_SIZE - 80) / 2,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.04)',
  },
  centerLabel: {
    width: CENTER_SIZE,
    height: CENTER_SIZE,
    borderRadius: CENTER_SIZE / 2,
    backgroundColor: '#1e1b4b',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#6366f1',
    overflow: 'hidden',
    paddingHorizontal: 4,
  },
  centerHole: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#000000',
    borderWidth: 1,
    borderColor: '#333',
  },
  labelTitle: {
    color: '#ffffff',
    fontSize: 6,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 8,
  },
  labelArtist: {
    color: '#a5b4fc',
    fontSize: 5,
    fontWeight: '600',
    textAlign: 'center',
  },
  labelIdle: {
    color: '#4b5563',
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: 1,
  },

  // ---- Tonearm ----
  tonearm: {
    position: 'absolute',
    top: 10,
    right: 15,
    width: 3,
    height: 60,
    backgroundColor: '#4b5563',
    borderRadius: 1.5,
    transform: [{ rotate: '25deg' }],
  },
  tonearmPlaying: {
    transform: [{ rotate: '15deg' }],
    backgroundColor: '#9ca3af',
  },
  tonearmHead: {
    position: 'absolute',
    top: 65,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 1,
    backgroundColor: '#6b7280',
    transform: [{ rotate: '25deg' }],
  },
  tonearmHeadPlaying: {
    transform: [{ rotate: '15deg' }],
    backgroundColor: '#a5b4fc',
  },

  scratchIndicator: {
    position: 'absolute',
    bottom: -2,
    backgroundColor: 'rgba(239, 68, 68, 0.8)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  scratchText: {
    color: '#ffffff',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 2,
  },

  // ---- Controls ----
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 6,
  },
  controlBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#1f2937',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#374151',
    marginRight: 16,
  },
  pitchSection: {
    alignItems: 'center',
  },
  pitchLabel: {
    color: '#6b7280',
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: 2,
    marginBottom: 4,
  },
  pitchTrack: {
    width: 8,
    height: 50,
    backgroundColor: '#1e293b',
    borderRadius: 4,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  pitchFill: {
    width: '100%',
    backgroundColor: '#6366f1',
    borderRadius: 4,
  },
  pitchBtns: {
    alignItems: 'center',
    marginTop: 4,
  },
  pitchBtn: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#1f2937',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 0.5,
    borderColor: '#374151',
    marginVertical: 1,
  },
  pitchValue: {
    color: '#818cf8',
    fontSize: 7,
    fontWeight: '800',
    marginVertical: 1,
  },

  // ---- Progress ----
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '90%',
    marginBottom: 8,
  },
  progressTime: {
    color: '#6b7280',
    fontSize: 8,
    fontWeight: '700',
    width: 24,
    textAlign: 'center',
  },
  progressTrack: {
    flex: 1,
    height: 3,
    backgroundColor: '#1e293b',
    borderRadius: 1.5,
    marginHorizontal: 6,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#6366f1',
    borderRadius: 1.5,
  },

  // ---- Crate ----
  crateLabel: {
    color: '#4b5563',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 2,
    marginBottom: 4,
    alignSelf: 'flex-start',
    marginLeft: 4,
  },
  crateList: {
    width: '100%',
  },
  crateItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 4,
    marginBottom: 2,
  },
  crateItemActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
  },
  crateTitle: {
    color: '#d1d5db',
    fontSize: 9,
    fontWeight: '600',
    flex: 1,
    marginLeft: 6,
  },
  crateDur: {
    color: '#6b7280',
    fontSize: 8,
    fontWeight: '700',
  },
});
