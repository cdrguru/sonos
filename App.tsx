import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { discoveryEngine } from './core/discovery';
import { stateStore, Speaker } from './core/stateStore';
import { bridgeClient, BridgeStatus } from './core/bridgeClient';
import { MainLayout } from './components/MainLayout';
import { TransportBar } from './components/TransportBar';

export default function App() {
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [selectedSpeaker, setSelectedSpeaker] = useState<Speaker | null>(null);
  const [loading, setLoading] = useState(true);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>('idle');

  // Start discovery engine and subscribe to state store updates
  useEffect(() => {
    let active = true;

    // Start discovery engine background loops
    discoveryEngine.start().then(() => {
      if (active) setLoading(false);
    });

    // Subscribe to stateStore updates
    const unsubscribe = stateStore.subscribe((updatedSpeakers) => {
      setSpeakers(updatedSpeakers);
      
      // Update currently selected speaker reference if it changes
      if (selectedSpeaker) {
        const freshSelected = updatedSpeakers.find((s) => s.id === selectedSpeaker.id);
        if (freshSelected) {
          setSelectedSpeaker(freshSelected);
        }
      } else if (updatedSpeakers.length > 0 && !selectedSpeaker) {
        // Default select first online speaker
        const firstOnline = updatedSpeakers.find((s) => s.status !== 'offline');
        if (firstOnline) {
          setSelectedSpeaker(firstOnline);
        }
      }
    });

    const unsubBridge = bridgeClient.subscribeStatus(setBridgeStatus);

    return () => {
      active = false;
      discoveryEngine.stop();
      unsubscribe();
      unsubBridge();
    };
  }, [selectedSpeaker]);

  useEffect(() => {
    stateStore.setSelectedSpeakerId(selectedSpeaker ? selectedSpeaker.id : null);
  }, [selectedSpeaker]);

  const handleRefreshScan = async () => {
    setLoading(true);
    await discoveryEngine.runParallelDiscovery();
    setLoading(false);
  };

  // Helper stats
  const onlineCount = speakers.filter((s) => s.status !== 'offline').length;
  const totalCount = speakers.length;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#050505" />

      {/* Top Banner Header */}
      <View style={styles.topHeader}>
        <View style={styles.brandRow}>
          <MaterialLogo />
          <View style={styles.titleStack}>
            <Text style={styles.brandTitle}>SONOS</Text>
            <Text style={styles.brandSubtitle}>vNEXT MIXER CONSOLE</Text>
          </View>
        </View>

        {/* Global Networking Status Badges */}
        <View style={styles.systemStatusRow}>
          <TouchableOpacity
            style={[styles.bridgeBadge, bridgeBadgeStyle(bridgeStatus)]}
            onPress={() => bridgeClient.reconnectNow()}
            accessibilityRole="button"
            accessibilityLabel={`Bridge ${bridgeStatus}. Tap to reconnect.`}
          >
            <View style={[styles.bridgeDot, bridgeDotStyle(bridgeStatus)]} />
            <Text style={[styles.bridgeBadgeText, bridgeTextStyle(bridgeStatus)]}>
              BRIDGE {bridgeStatus.toUpperCase()}
            </Text>
          </TouchableOpacity>

          <View style={styles.statusBadge}>
            <View style={styles.badgeIndicatorDot} />
            <Text style={styles.statusBadgeText}>
              {onlineCount}/{totalCount} Active Nodes
            </Text>
          </View>

          <TouchableOpacity style={styles.refreshIconBtn} onPress={handleRefreshScan} disabled={loading}>
            {loading ? (
              <ActivityIndicator size="small" color="#818cf8" />
            ) : (
              <Ionicons name="refresh-circle-outline" size={24} color="#e5e7eb" />
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Main 3-Pane Mixing Board */}
      <View style={styles.mainBoardWrapper}>
        {speakers.length === 0 ? (
          <View style={styles.loadingConsole}>
            <ActivityIndicator size="large" color="#6366f1" />
            <Text style={styles.loadingText}>Initializing SSDP/mDNS network search...</Text>
          </View>
        ) : (
          <MainLayout
            speakers={speakers}
            selectedSpeaker={selectedSpeaker}
            setSelectedSpeaker={setSelectedSpeaker}
          />
        )}
      </View>

      {/* Global Transport & Seek Controller */}
      <TransportBar
        selectedSpeaker={selectedSpeaker}
        allSpeakers={speakers}
      />
    </SafeAreaView>
  );
}

function bridgeBadgeStyle(status: BridgeStatus) {
  switch (status) {
    case 'connected':
      return { borderColor: 'rgba(52, 211, 153, 0.4)', backgroundColor: 'rgba(52, 211, 153, 0.10)' };
    case 'connecting':
      return { borderColor: 'rgba(251, 191, 36, 0.4)', backgroundColor: 'rgba(251, 191, 36, 0.10)' };
    default:
      return { borderColor: 'rgba(239, 68, 68, 0.4)', backgroundColor: 'rgba(239, 68, 68, 0.10)' };
  }
}

function bridgeDotStyle(status: BridgeStatus) {
  switch (status) {
    case 'connected':
      return { backgroundColor: '#34d399' };
    case 'connecting':
      return { backgroundColor: '#fbbf24' };
    default:
      return { backgroundColor: '#f87171' };
  }
}

function bridgeTextStyle(status: BridgeStatus) {
  switch (status) {
    case 'connected':
      return { color: '#34d399' };
    case 'connecting':
      return { color: '#fbbf24' };
    default:
      return { color: '#f87171' };
  }
}

// Decorative logo
const MaterialLogo = () => (
  <View style={logoStyles.container}>
    <View style={[logoStyles.bar, { height: 14 }]} />
    <View style={[logoStyles.bar, { height: 24, backgroundColor: '#818cf8' }]} />
    <View style={[logoStyles.bar, { height: 18 }]} />
    <View style={[logoStyles.bar, { height: 8 }]} />
  </View>
);

const logoStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
    height: 30,
  },
  bar: {
    width: 3,
    backgroundColor: '#ffffff',
    marginHorizontal: 1.5,
    borderRadius: 1.5,
  },
});

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#050505',
  },
  topHeader: {
    height: 60,
    backgroundColor: '#0a0a0a',
    borderBottomWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  titleStack: {
    justifyContent: 'center',
  },
  brandTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 2,
  },
  brandSubtitle: {
    color: '#6366f1',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginTop: 1,
  },
  systemStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bridgeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 20,
    borderWidth: 0.5,
    marginRight: 8,
  },
  bridgeDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginRight: 6,
  },
  bridgeBadgeText: {
    fontSize: 9,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(52, 211, 153, 0.12)',
    borderWidth: 0.5,
    borderColor: 'rgba(52, 211, 153, 0.25)',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 20,
    marginRight: 12,
  },
  badgeIndicatorDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#34d399',
    marginRight: 6,
  },
  statusBadgeText: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: 'bold',
  },
  refreshIconBtn: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  mainBoardWrapper: {
    flex: 1,
    backgroundColor: '#050505',
  },
  loadingConsole: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0a0a0a',
  },
  loadingText: {
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 16,
    letterSpacing: 0.5,
  },
});
