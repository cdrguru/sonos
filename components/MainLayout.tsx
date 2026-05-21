import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  TextInput,
  Alert,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Speaker, stateStore, PlayQueueItem, Scene } from '../core/stateStore';
import { discoveryEngine, NetworkLog } from '../core/discovery';
import { ChannelStrip } from './ChannelStrip';

interface MainLayoutProps {
  speakers: Speaker[];
  selectedSpeaker: Speaker | null;
  setSelectedSpeaker: (speaker: Speaker | null) => void;
}

export const MainLayout: React.FC<MainLayoutProps> = ({
  speakers,
  selectedSpeaker,
  setSelectedSpeaker,
}) => {
  const [networkLogs, setNetworkLogs] = useState<NetworkLog[]>([]);
  const [activeTab, setActiveTab] = useState<'sources' | 'logs' | 'scenes'>('sources');
  const [queue, setQueue] = useState<PlayQueueItem[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [newSceneName, setNewSceneName] = useState('');
  
  // Drag & drop grouping states
  const [draggedSpeakerId, setDraggedSpeakerId] = useState<string | null>(null);
  const [dragCoords, setDragCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const cardRefs = useRef<Record<string, { x: number; y: number; width: number; height: number }>>({});

  // Subscribe to discovery engine logs + state store queue/scenes updates
  useEffect(() => {
    const unsubLogs = discoveryEngine.onLogsChange((logs) => {
      setNetworkLogs(logs);
    });
    const unsubQueue = stateStore.subscribeQueue((q) => {
      setQueue(q);
    });
    const unsubScenes = stateStore.subscribeScenes((s) => {
      setScenes(s);
    });
    return () => {
      unsubLogs();
      unsubQueue();
      unsubScenes();
    };
  }, []);

  const handleSaveScene = async () => {
    const name = newSceneName.trim();
    if (!name) return;
    await stateStore.saveScene(name);
    setNewSceneName('');
  };

  const formatSceneTimestamp = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  // Drag Gesture Handlers passed down to ChannelStrips
  const handleDragStart = (speakerId: string, pageX: number, pageY: number) => {
    setDraggedSpeakerId(speakerId);
    setDragCoords({ x: pageX, y: pageY });
  };

  const handleDragMove = (pageX: number, pageY: number) => {
    setDragCoords({ x: pageX, y: pageY });
  };

  const handleDragEnd = (pageX: number, pageY: number) => {
    if (!draggedSpeakerId) return;

    // Detect collision with other cards
    let targetSpeakerId: string | null = null;
    const cards = cardRefs.current;

    for (const [id, rect] of Object.entries(cards)) {
      if (id === draggedSpeakerId) continue; // Cannot group with self

      const hit =
        pageX >= rect.x &&
        pageX <= rect.x + rect.width &&
        pageY >= rect.y &&
        pageY <= rect.y + rect.height;

      if (hit) {
        targetSpeakerId = id;
        break;
      }
    }

    if (targetSpeakerId) {
      // Trigger grouping
      stateStore.groupSpeakers(targetSpeakerId, draggedSpeakerId);
    }

    // Reset drag states
    setDraggedSpeakerId(null);
  };

  // Mock playlists for sources aggregation
  const mediaSources = [
    {
      id: 'src-spotify',
      name: 'Spotify Connect',
      icon: 'spotify',
      color: '#1db954',
      tracks: [
        { id: 'sp1', title: 'Late Night Chill', artist: 'Lofi Generator', duration: 180, artwork: '' },
        { id: 'sp2', title: 'Midnight Espresso', artist: 'Hazy Beats', duration: 210, artwork: '' },
      ],
    },
    {
      id: 'src-apple',
      name: 'Apple Music',
      icon: 'apple',
      color: '#fc3c44',
      tracks: [
        { id: 'ap1', title: 'Essentials Mix 2026', artist: 'Apple Curated', duration: 250, artwork: '' },
        { id: 'ap2', title: 'Classical Focus', artist: 'Symphony Hall', duration: 320, artwork: '' },
      ],
    },
    {
      id: 'src-nas',
      name: 'Local NAS (FLAC)',
      icon: 'nas',
      color: '#eab308',
      tracks: [
        { id: 'nas1', title: 'Hotel California (Remaster)', artist: 'Eagles', duration: 390, artwork: '' },
        { id: 'nas2', title: 'Stairway to Heaven', artist: 'Led Zeppelin', duration: 482, artwork: '' },
      ],
    },
  ];

  const handlePlaySourceTrack = (track: any) => {
    if (!selectedSpeaker) return;
    
    // Construct PlayQueueItem
    const queueItem: PlayQueueItem = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      artwork: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=150&auto=format&fit=crop&q=60',
      duration: track.duration,
    };
    
    stateStore.playTrackFromQueue(selectedSpeaker.id, queueItem);
  };

  const getLogStyle = (level: NetworkLog['level']) => {
    switch (level) {
      case 'success':
        return styles.logSuccess;
      case 'warn':
        return styles.logWarn;
      case 'error':
        return styles.logError;
      default:
        return styles.logInfo;
    }
  };

  const draggedSpeakerName = speakers.find((s) => s.id === draggedSpeakerId)?.name || '';

  return (
    <View style={styles.container}>
      {/* 1. LEFT PANE: Media Sources & Real-time Network Console */}
      <View style={styles.leftPane}>
        {/* Top Tab Selectors */}
        <View style={styles.tabsRow}>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'sources' && styles.tabButtonActive]}
            onPress={() => setActiveTab('sources')}
          >
            <Ionicons name="musical-notes" size={12} color={activeTab === 'sources' ? '#ffffff' : '#6b7280'} />
            <Text style={[styles.tabText, activeTab === 'sources' && styles.tabTextActive]}>
              Sources
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'scenes' && styles.tabButtonActive]}
            onPress={() => setActiveTab('scenes')}
          >
            <MaterialCommunityIcons name="palette" size={12} color={activeTab === 'scenes' ? '#ffffff' : '#6b7280'} />
            <Text style={[styles.tabText, activeTab === 'scenes' && styles.tabTextActive]}>
              Scenes
            </Text>
            {scenes.length > 0 && (
              <View style={styles.tabBadge}>
                <Text style={styles.tabBadgeText}>{scenes.length}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'logs' && styles.tabButtonActive]}
            onPress={() => setActiveTab('logs')}
          >
            <Ionicons name="terminal" size={12} color={activeTab === 'logs' ? '#ffffff' : '#6b7280'} />
            <Text style={[styles.tabText, activeTab === 'logs' && styles.tabTextActive]}>
              Logs
            </Text>
          </TouchableOpacity>
        </View>

        {activeTab === 'sources' ? (
          <ScrollView style={styles.leftContentScroll} showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionHeader}>Aggregated Services</Text>
            {mediaSources.map((source) => (
              <View key={source.id} style={styles.sourceGroup}>
                <View style={styles.sourceHeader}>
                  {source.icon === 'spotify' && (
                    <MaterialCommunityIcons name="spotify" size={18} color={source.color} />
                  )}
                  {source.icon === 'apple' && (
                    <MaterialCommunityIcons name="apple" size={18} color={source.color} />
                  )}
                  {source.icon === 'nas' && (
                    <MaterialCommunityIcons name="nas" size={18} color={source.color} />
                  )}
                  <Text style={styles.sourceTitle}>{source.name}</Text>
                </View>
                {source.tracks.map((track) => (
                  <View
                    key={track.id}
                    style={[
                      styles.sourceTrackItem,
                      !selectedSpeaker && styles.sourceTrackItemDisabled,
                    ]}
                  >
                    <TouchableOpacity
                      style={styles.sourceTrackPressable}
                      disabled={!selectedSpeaker}
                      onPress={() => handlePlaySourceTrack(track)}
                      accessibilityLabel={`Play ${track.title} on ${selectedSpeaker?.name || 'selected speaker'}`}
                    >
                      <View style={styles.trackPlayIndicator}>
                        <Ionicons name="play" size={10} color="#818cf8" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.sourceTrackName}>{track.title}</Text>
                        <Text style={styles.sourceTrackArtist}>{track.artist}</Text>
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.sourceQueueAddBtn}
                      onPress={() =>
                        stateStore.addToQueue({
                          id: `q-${Date.now()}-${track.id}`,
                          title: track.title,
                          artist: track.artist,
                          artwork:
                            'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=150&auto=format&fit=crop&q=60',
                          duration: track.duration,
                        })
                      }
                      accessibilityLabel={`Add ${track.title} to queue`}
                    >
                      <Ionicons name="add-circle-outline" size={16} color="#a5b4fc" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
        ) : activeTab === 'scenes' ? (
          <View style={styles.scenesContainer}>
            <Text style={styles.sectionHeader}>Snapshot Current Console</Text>
            <View style={styles.sceneInputRow}>
              <TextInput
                value={newSceneName}
                onChangeText={setNewSceneName}
                placeholder="e.g. Movie Night, Party Mode"
                placeholderTextColor="#4b5563"
                style={styles.sceneInput}
                maxLength={32}
                returnKeyType="done"
                onSubmitEditing={handleSaveScene}
              />
              <TouchableOpacity
                style={[styles.sceneSaveBtn, !newSceneName.trim() && styles.sceneSaveBtnDisabled]}
                disabled={!newSceneName.trim()}
                onPress={handleSaveScene}
                accessibilityLabel="Save current console state as a scene"
              >
                <Ionicons name="save" size={11} color={newSceneName.trim() ? '#ffffff' : '#4b5563'} />
                <Text style={[styles.sceneSaveBtnText, !newSceneName.trim() && { color: '#4b5563' }]}>
                  Save
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.sceneHelp}>
              Captures volume, mute, EQ and zone grouping for every player.
            </Text>

            <Text style={[styles.sectionHeader, { marginTop: 16 }]}>Saved Scenes</Text>
            <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
              {scenes.length === 0 ? (
                <View style={styles.scenesEmpty}>
                  <MaterialCommunityIcons name="palette-outline" size={28} color="#374151" />
                  <Text style={styles.scenesEmptyText}>No scenes saved yet</Text>
                  <Text style={styles.scenesEmptySubText}>
                    Configure the mixer, then save a snapshot above.
                  </Text>
                </View>
              ) : (
                scenes
                  .slice()
                  .reverse()
                  .map((scene) => (
                    <View key={scene.id} style={styles.sceneCard}>
                      <View style={styles.sceneCardHeader}>
                        <View style={{ flex: 1 }}>
                          <Text numberOfLines={1} style={styles.sceneCardName}>
                            {scene.name}
                          </Text>
                          <Text style={styles.sceneCardMeta}>
                            {scene.snapshot.length} players · {formatSceneTimestamp(scene.createdAt)}
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={styles.sceneDeleteBtn}
                          onPress={() => stateStore.deleteScene(scene.id)}
                          accessibilityLabel={`Delete scene ${scene.name}`}
                        >
                          <Ionicons name="trash" size={11} color="#f87171" />
                        </TouchableOpacity>
                      </View>
                      <TouchableOpacity
                        style={styles.sceneApplyBtn}
                        onPress={() => stateStore.applyScene(scene.id)}
                        accessibilityLabel={`Apply scene ${scene.name}`}
                      >
                        <Ionicons name="play-circle" size={12} color="#ffffff" />
                        <Text style={styles.sceneApplyBtnText}>Apply Scene</Text>
                      </TouchableOpacity>
                    </View>
                  ))
              )}
            </ScrollView>
          </View>
        ) : (
          <View style={styles.logsContainer}>
            {/* Simulation controllers */}
            <View style={styles.simButtonsRow}>
              <TouchableOpacity
                style={styles.simBtn}
                onPress={() => discoveryEngine.simulateNetworkEvent('new_speaker')}
              >
                <Ionicons name="add-circle" size={11} color="#34d399" />
                <Text style={styles.simBtnText}>Join Spk</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.simBtn, styles.simBtnWarning]}
                onPress={() => discoveryEngine.simulateNetworkEvent('drop')}
              >
                <Ionicons name="wifi" size={11} color="#f87171" />
                <Text style={[styles.simBtnText, { color: '#f87171' }]}>Lossy Net</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.simBtn}
                onPress={() => discoveryEngine.simulateNetworkEvent('restore')}
              >
                <Ionicons name="refresh" size={11} color="#60a5fa" />
                <Text style={styles.simBtnText}>Recover</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.logList}
              contentContainerStyle={{ paddingBottom: 16 }}
              showsVerticalScrollIndicator={true}
            >
              {networkLogs.length === 0 ? (
                <Text style={styles.noLogsText}>No topology pings recorded yet.</Text>
              ) : (
                networkLogs.map((log, index) => (
                  <View key={index} style={styles.logItem}>
                    <View style={styles.logHeaderLine}>
                      <Text style={[styles.logProtocol, { color: log.protocol === 'SSDP' ? '#fb7185' : log.protocol === 'mDNS' ? '#38bdf8' : '#818cf8' }]}>
                        [{log.protocol}]
                      </Text>
                      <Text style={styles.logTime}>{log.timestamp}</Text>
                    </View>
                    <Text style={[styles.logMsg, getLogStyle(log.level)]}>
                      {log.message}
                    </Text>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        )}
      </View>

      {/* 2. CENTER PANE: Dynamic Mixer Channel Strips */}
      <View style={styles.centerPane}>
        <View style={styles.centerHeader}>
          <Text style={styles.paneTitle}>Active Mixer Board</Text>
          <Text style={styles.paneSubtitle}>
            Selected Room:{' '}
            <Text style={{ color: '#818cf8', fontWeight: 'bold' }}>
              {selectedSpeaker ? selectedSpeaker.name : 'None'}
            </Text>
          </Text>
        </View>

        <ScrollView
          horizontal
          style={styles.stripsScrollView}
          contentContainerStyle={styles.stripsContainer}
          showsHorizontalScrollIndicator={true}
        >
          {speakers.map((spk) => {
            const isSelected = selectedSpeaker?.id === spk.id;
            return (
              <TouchableOpacity
                key={spk.id}
                activeOpacity={0.9}
                onPress={() => setSelectedSpeaker(spk)}
                style={[
                  styles.stripCardWrapper,
                  isSelected && styles.stripCardSelected,
                ]}
              >
                <ChannelStrip
                  speaker={spk}
                  allSpeakers={speakers}
                  onDragStart={handleDragStart}
                  onDragMove={handleDragMove}
                  onDragEnd={handleDragEnd}
                  cardRefs={cardRefs}
                />
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* 3. RIGHT PANE: Global Playback Queue */}
      <View style={styles.rightPane}>
        <View style={styles.queueHeader}>
          <Ionicons name="list" size={16} color="#ffffff" />
          <Text style={styles.rightPaneTitle}>Queue List</Text>
          <Text style={styles.queueCount}>({queue.length})</Text>
        </View>

        {selectedSpeaker ? (
          queue.length === 0 ? (
            <View style={styles.noQueuePlaceholder}>
              <Ionicons name="list" size={28} color="#374151" />
              <Text style={styles.noQueueText}>Queue empty</Text>
              <Text style={styles.noQueueSubText}>Tap + on a media source to enqueue</Text>
            </View>
          ) : (
            <FlatList
              data={queue}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.queueList}
              showsVerticalScrollIndicator={false}
              renderItem={({ item, index }) => {
                const isCurrent = selectedSpeaker.currentTrack?.title === item.title;
                const isFirst = index === 0;
                const isLast = index === queue.length - 1;
                return (
                  <View style={[styles.queueItem, isCurrent && styles.queueItemActive]}>
                    <TouchableOpacity
                      style={styles.queueItemPressable}
                      onPress={() => stateStore.playTrackFromQueue(selectedSpeaker.id, item)}
                      accessibilityLabel={`Play ${item.title}`}
                    >
                      <View style={styles.queueItemIndex}>
                        {isCurrent ? (
                          <Ionicons name="volume-medium" size={14} color="#818cf8" />
                        ) : (
                          <Ionicons name="musical-note" size={12} color="#4b5563" />
                        )}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text numberOfLines={1} style={[styles.queueTrackTitle, isCurrent && styles.queueTrackActiveText]}>
                          {item.title}
                        </Text>
                        <Text numberOfLines={1} style={styles.queueTrackArtist}>
                          {item.artist}
                        </Text>
                      </View>
                      <Text style={styles.queueTrackDuration}>
                        {Math.floor(item.duration / 60)}:{(item.duration % 60) < 10 ? '0' : ''}{item.duration % 60}
                      </Text>
                    </TouchableOpacity>
                    <View style={styles.queueItemActions}>
                      <TouchableOpacity
                        style={[styles.queueItemActionBtn, isFirst && styles.queueItemActionBtnDisabled]}
                        disabled={isFirst}
                        onPress={() => stateStore.reorderQueue(item.id, 'up')}
                        accessibilityLabel={`Move ${item.title} up`}
                      >
                        <Ionicons name="chevron-up" size={11} color={isFirst ? '#374151' : '#9ca3af'} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.queueItemActionBtn, isLast && styles.queueItemActionBtnDisabled]}
                        disabled={isLast}
                        onPress={() => stateStore.reorderQueue(item.id, 'down')}
                        accessibilityLabel={`Move ${item.title} down`}
                      >
                        <Ionicons name="chevron-down" size={11} color={isLast ? '#374151' : '#9ca3af'} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.queueItemActionBtnDanger}
                        onPress={() => stateStore.removeFromQueue(item.id)}
                        accessibilityLabel={`Remove ${item.title} from queue`}
                      >
                        <Ionicons name="close" size={11} color="#f87171" />
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              }}
            />
          )
        ) : (
          <View style={styles.noQueuePlaceholder}>
            <Text style={styles.noQueueText}>Select a room to load play queue</Text>
          </View>
        )}
      </View>

      {/* Drag & Drop Grouping Ghost Overlay */}
      {draggedSpeakerId && (
        <View
          pointerEvents="none"
          style={[
            styles.dragGhostOverlay,
            {
              left: dragCoords.x - 70,
              top: dragCoords.y - 30,
            },
          ]}
        >
          <MaterialCommunityIcons name="drag-variant" size={16} color="#818cf8" style={{ marginRight: 6 }} />
          <Text style={styles.dragGhostText} numberOfLines={1}>
            Group {draggedSpeakerName}
          </Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#0a0a0a',
  },
  leftPane: {
    width: '24%',
    backgroundColor: '#121212',
    borderRightWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    padding: 16,
  },
  tabsRow: {
    flexDirection: 'row',
    backgroundColor: '#1f2937',
    borderRadius: 8,
    padding: 2,
    marginBottom: 16,
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderRadius: 6,
  },
  tabButtonActive: {
    backgroundColor: '#111827',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
  },
  tabText: {
    color: '#6b7280',
    fontSize: 10,
    fontWeight: '700',
    marginLeft: 4,
  },
  tabTextActive: {
    color: '#ffffff',
  },
  tabBadge: {
    marginLeft: 4,
    minWidth: 14,
    height: 14,
    paddingHorizontal: 3,
    borderRadius: 7,
    backgroundColor: '#6366f1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tabBadgeText: {
    color: '#ffffff',
    fontSize: 8,
    fontWeight: '800',
  },
  scenesContainer: {
    flex: 1,
  },
  sceneInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  sceneInput: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    color: '#ffffff',
    fontSize: 11,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.06)',
    marginRight: 6,
  },
  sceneSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#6366f1',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  sceneSaveBtnDisabled: {
    backgroundColor: '#1f2937',
  },
  sceneSaveBtnText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
    marginLeft: 4,
  },
  sceneHelp: {
    color: '#6b7280',
    fontSize: 9,
    fontWeight: '500',
    fontStyle: 'italic',
    marginTop: 2,
  },
  scenesEmpty: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  scenesEmptyText: {
    color: '#4b5563',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 8,
  },
  scenesEmptySubText: {
    color: '#374151',
    fontSize: 9,
    fontWeight: '500',
    marginTop: 4,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  sceneCard: {
    backgroundColor: 'rgba(99, 102, 241, 0.05)',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    borderWidth: 0.5,
    borderColor: 'rgba(99, 102, 241, 0.2)',
  },
  sceneCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  sceneCardName: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  sceneCardMeta: {
    color: '#6b7280',
    fontSize: 9,
    fontWeight: '500',
    marginTop: 2,
  },
  sceneDeleteBtn: {
    width: 22,
    height: 22,
    borderRadius: 4,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 0.5,
    borderColor: 'rgba(239, 68, 68, 0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  sceneApplyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    borderRadius: 6,
    paddingVertical: 6,
    borderWidth: 0.5,
    borderColor: 'rgba(99, 102, 241, 0.35)',
  },
  sceneApplyBtnText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
    marginLeft: 4,
  },
  leftContentScroll: {
    flex: 1,
  },
  sectionHeader: {
    color: '#9ca3af',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  sourceGroup: {
    marginBottom: 16,
  },
  sourceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    backgroundColor: 'rgba(255,255,255,0.02)',
    padding: 6,
    borderRadius: 6,
  },
  sourceTitle: {
    color: '#e5e7eb',
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 8,
  },
  sourceTrackItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 6,
    marginBottom: 4,
    backgroundColor: 'rgba(255,255,255,0.01)',
  },
  sourceTrackPressable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 2,
    paddingRight: 4,
  },
  sourceQueueAddBtn: {
    width: 26,
    height: 26,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 13,
    backgroundColor: 'rgba(99, 102, 241, 0.08)',
    borderWidth: 0.5,
    borderColor: 'rgba(99, 102, 241, 0.25)',
  },
  sourceTrackItemDisabled: {
    opacity: 0.4,
  },
  trackPlayIndicator: {
    marginRight: 8,
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
    width: 16,
    height: 16,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sourceTrackName: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '600',
  },
  sourceTrackArtist: {
    color: '#6b7280',
    fontSize: 8,
    fontWeight: '500',
    marginTop: 1,
  },
  logsContainer: {
    flex: 1,
  },
  simButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  simBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1f2937',
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#374151',
  },
  simBtnWarning: {
    borderColor: 'rgba(248, 113, 113, 0.3)',
  },
  simBtnText: {
    color: '#e5e7eb',
    fontSize: 9,
    fontWeight: '700',
    marginLeft: 3,
  },
  logList: {
    flex: 1,
    backgroundColor: '#070707',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.03)',
  },
  noLogsText: {
    color: '#4b5563',
    fontSize: 9,
    textAlign: 'center',
    marginTop: 20,
    fontStyle: 'italic',
  },
  logItem: {
    marginBottom: 8,
    borderBottomWidth: 0.5,
    borderColor: '#111827',
    paddingBottom: 6,
  },
  logHeaderLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  logProtocol: {
    fontSize: 8,
    fontWeight: 'bold',
  },
  logTime: {
    color: '#4b5563',
    fontSize: 8,
  },
  logMsg: {
    fontSize: 9.5,
    fontFamily: 'Courier',
  },
  logInfo: {
    color: '#9ca3af',
  },
  logSuccess: {
    color: '#34d399',
  },
  logWarn: {
    color: '#fbbf24',
  },
  logError: {
    color: '#f87171',
  },
  centerPane: {
    flex: 1,
    padding: 16,
  },
  centerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: 16,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,0.03)',
    paddingBottom: 8,
  },
  paneTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  paneSubtitle: {
    color: '#9ca3af',
    fontSize: 11,
  },
  stripsScrollView: {
    flex: 1,
  },
  stripsContainer: {
    alignItems: 'center',
    paddingVertical: 10,
    paddingRight: 16,
  },
  stripCardWrapper: {
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: 'transparent',
    marginRight: 4,
  },
  stripCardSelected: {
    borderColor: '#6366f1',
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  rightPane: {
    width: '24%',
    backgroundColor: '#121212',
    borderLeftWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    padding: 16,
  },
  queueHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,0.03)',
    paddingBottom: 8,
  },
  rightPaneTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
    marginLeft: 8,
  },
  queueCount: {
    color: '#6b7280',
    fontSize: 11,
    fontWeight: 'bold',
    marginLeft: 4,
  },
  queueList: {
    paddingBottom: 16,
  },
  queueItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    marginBottom: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.01)',
    borderWidth: 0.5,
    borderColor: 'rgba(255, 255, 255, 0.02)',
  },
  queueItemPressable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  queueItemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 4,
  },
  queueItemActionBtn: {
    width: 18,
    height: 18,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.06)',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 3,
  },
  queueItemActionBtnDisabled: {
    opacity: 0.3,
  },
  queueItemActionBtnDanger: {
    width: 18,
    height: 18,
    borderRadius: 4,
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    borderWidth: 0.5,
    borderColor: 'rgba(239, 68, 68, 0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 4,
  },
  queueItemActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.08)',
    borderColor: 'rgba(99, 102, 241, 0.25)',
  },
  queueItemIndex: {
    width: 20,
    alignItems: 'center',
  },
  queueTrackTitle: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  queueTrackActiveText: {
    color: '#a5b4fc',
    fontWeight: '700',
  },
  queueTrackArtist: {
    color: '#6b7280',
    fontSize: 9,
    fontWeight: '500',
    marginTop: 1,
  },
  queueTrackDuration: {
    color: '#4b5563',
    fontSize: 9,
    fontWeight: '700',
    marginLeft: 6,
  },
  noQueuePlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  noQueueText: {
    color: '#4b5563',
    fontSize: 11,
    textAlign: 'center',
    fontWeight: '700',
    marginTop: 8,
  },
  noQueueSubText: {
    color: '#374151',
    fontSize: 9,
    textAlign: 'center',
    fontWeight: '500',
    marginTop: 4,
    fontStyle: 'italic',
  },
  dragGhostOverlay: {
    position: 'absolute',
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    borderWidth: 1.5,
    borderColor: '#6366f1',
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    zIndex: 9999,
  },
  dragGhostText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold',
  },
});
