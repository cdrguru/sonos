# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project Overview

**Sonos vNext Mixer Console** — an Expo SDK 54 / React Native app simulating a multi-room speaker controller. No real Sonos network I/O exists; the app mocks SSDP discovery, UPnP SOAP commands, and cloud API fallback using timers and local state. The UI is a dark-themed, high-density 3-pane mixing board with vertical channel-strip faders, drag-and-drop zone grouping, and a global transport bar.

## Commands

```bash
npm start          # Launch Expo dev server (Metro)
npm run web        # Start with web target (recommended for development)
npm run ios        # Start with iOS simulator
npm run android    # Start with Android emulator
npx tsc --noEmit   # Typecheck (no script wired; run directly)
```

There is **no test runner, linter, or formatter** configured. Do not fabricate `npm test` or `npm run lint` invocations.

## Architecture

Single-process app with a deliberate one-way data flow. Three singletons form the core pipeline:

```text
discoveryEngine (core/discovery.ts)    ← simulated SSDP/mDNS/cache network layer
    │  onTopologyChange → reconcileTopology
    ▼
stateStore (core/stateStore.ts)        ← optimistic UI state + cloud fallback routing
    │  subscribe
    ▼
App.tsx → MainLayout → ChannelStrip / TransportBar
    ▲
    │
syncEngine (core/syncEngine.ts)        ← per-speaker CRDT conflict resolver (800ms lockout)
```

### File Map

```text
├── core/
│   ├── discovery.ts       # ResilientDiscoveryEngine singleton
│   ├── syncEngine.ts      # LocalFirstSyncEngine class (per-speaker instance)
│   └── stateStore.ts      # StateStore singleton (orchestrates sync engines + cloud fallback)
├── components/
│   ├── MainLayout.tsx     # 3-pane grid: left (sources/logs), center (mixer strips), right (queue)
│   ├── ChannelStrip.tsx   # Per-speaker vertical fader card with ghost indicators
│   └── TransportBar.tsx   # Bottom global transport: play/pause/seek, master volume, group actions
├── App.tsx                # Entry point: boots discovery engine, subscribes to state store
├── research.md            # Protocol reference manual (SSDP, UPnP SOAP, Cloud API, CRDT math)
├── app.json               # Expo config (SDK 54, newArchEnabled: true)
├── tsconfig.json          # extends expo/tsconfig.base, strict: true
└── package.json           # Expo 54, React 19.1, React Native 0.81.5
```

### `core/discovery.ts` — `ResilientDiscoveryEngine`

- Persists speaker registry to `AsyncStorage` under key `@sonos_vnext_speaker_registry`. Seeds from `INITIAL_SPEAKERS` on first run.
- `start()` runs `runParallelDiscovery()` (simulated SSDP M-SEARCH + mDNS + cache sweep via `setTimeout`) and starts a 5-second background ping loop that mutates speaker `status` and advances `currentTrack.progress`.
- Emits structured `NetworkLog` entries (capped at 80) via `onLogsChange`. Topology changes broadcast via `onTopologyChange`.
- `addLog()` is **public** — called by `stateStore` to inject SOAP/Cloud log entries.
- Speaker `pathway` field tracks `'local' | 'cloud'` routing state. Discovery sweeps reset online speakers to `'local'`.
- `stop()` must be called on unmount — `App.tsx` does this in its effect cleanup.
- Log protocol types: `'SSDP' | 'mDNS' | 'CACHE' | 'PING' | 'SYSTEM' | 'CLOUD'`.

### `core/syncEngine.ts` — `LocalFirstSyncEngine`

- Implements the CRDT state machine from `research.md` Zone 4.
- State tuple per speaker: `{ confirmedVolume, optimisticVolume, syncState, lastLocalWriteTime, lastSequenceId, pendingCorrelationId }`.
- `registerUserInteraction(volume, correlationId)` locks state to `PENDING` and starts 800ms temporal lockout.
- `receiveHardwareUpdate(volume, seqId, correlationId)` resolves: matching correlation → instant confirm; lockout expired → yield to hardware; otherwise → ignore (prevents slider bounce).
- `getDisplayVolume()` returns optimistic value when PENDING, confirmed value when CONFIRMED.

### `core/stateStore.ts` — `StateStore`

- Holds live `Speaker[]` and reconciles topology from discovery engine using per-speaker version clocks (LWW).
- Each speaker gets a lazy-initialized `LocalFirstSyncEngine` instance.
- **Volume flow**: `setVolume()` → generate `tx-XXXXXXXX` correlation ID → register in sync engine → dispatch local SOAP simulation (200ms) → on timeout, escalate to cloud fallback (350ms).
- **Cloud fallback**: `dispatchCloudSetVolume()` logs OAuth2 HTTPS POST to `api.ws.sonos.com`, simulates WebSocket event notification, and resolves sync engine. Sets speaker `pathway` to `'cloud'`. Subsequent volume changes on cloud-pathway speakers bypass local SOAP and go directly to cloud.
- **Zone groups**: derived from `Speaker.zoneId` (no separate group table). `groupSpeakers` assigns `zone-<masterId>`; `ungroupSpeaker` auto-collapses zones with ≤1 member. Group volume applies proportional delta across members.
- `spk-patio` is **hard-coded to always timeout locally** — it always escalates to cloud fallback.
- Exports: `stateStore`, `getPendingOptimisticVolume(id)`.

### Components

- **`App.tsx`**: Boots engine, owns `selectedSpeaker` state, renders header/board/transport shell. The `useEffect` has `[selectedSpeaker]` dependency — be careful not to create infinite re-render loops if changing this.
- **`MainLayout.tsx`**: 3-pane board. Left pane toggles between Media Sources (Spotify/Apple/NAS mock lists) and Topology Logs (live NetworkLog stream + simulation buttons: Join Speaker, Lossy Net, Recover). Center pane: horizontal `ScrollView` of `ChannelStrip` cards with selection glow. Right pane: `FlatList` play queue. Owns drag/drop coordinates via `cardRefs` map for grouping hit-testing.
- **`ChannelStrip.tsx`**: Per-speaker fader card. Custom `PanResponder` for vertical volume gesture. Ghost indicator (translucent blue overlay during drag), hardware volume track, pulsing `Animated.View` during PENDING sync state. Reads `stateStore.getSyncState(speaker.id)` to determine pending status. Shows cloud icon (`cloud-outline`) when `speaker.pathway === 'cloud'`. Footer: play/pause button + ZONE drag handle + unlink button.
- **`TransportBar.tsx`**: Global play/pause/skip controls, progress scrub bar with timer, master volume ±5 buttons, Group All / Ungroup All quick actions.

## Constraints

- **Expo SDK 54 / new architecture enabled** (`app.json: newArchEnabled: true`). Always check versioned docs at <https://docs.expo.dev/versions/v54.0.0/> before adding packages or APIs — older Expo guidance is frequently wrong.
- **No native folders** (`/ios`, `/android` are gitignored) — managed Expo project. Don't suggest editing native code; use config plugins or Expo APIs.
- TypeScript `strict` is on (via `expo/tsconfig.base`).
- Singletons (`discoveryEngine`, `stateStore`) are module-scoped — they survive Fast Refresh, so reloads may show stale subscriptions. The `App.tsx` effect cleanup matters.
- Icons come from `@expo/vector-icons` (`Ionicons` and `MaterialCommunityIcons`). When using icon names, verify they exist in the icon set — invalid names cause TS errors.

## What Has Been Built (Complete)

1. ✅ Project scaffolding (Expo 54, TypeScript strict, AsyncStorage, vector-icons)
2. ✅ Network discovery engine with simulated SSDP/mDNS/cache parallel sweeps
3. ✅ CRDT sync engine with 800ms temporal lockout and correlation ID tracking
4. ✅ Optimistic state store with LWW conflict resolution
5. ✅ Cloud-fallback WAN routing (OAuth2 HTTPS + WebSocket event simulation)
6. ✅ 3-pane mixer board layout (sources/scenes/logs, channel strips, play queue)
7. ✅ Interactive vertical faders with ghost indicators and pulse animations
8. ✅ Drag-and-drop zone grouping with hit-test collision detection
9. ✅ Global transport bar (play/pause, master volume, group actions)
10. ✅ Cloud pathway indicator icons on channel strips
11. ✅ Mute toggle (`RenderingControl:1#SetMute` SOAP + Cloud) on `ChannelStrip` and `TransportBar`
12. ✅ Per-speaker EQ modal — bass, treble, loudness, night mode — wired to `stateStore.setEQ`
13. ✅ Persistent **Scenes/Presets**: snapshot volume + mute + EQ + zone topology to `AsyncStorage` under `@sonos_vnext_scenes`; Save/Apply/Delete from the Scenes tab
14. ✅ Queue management — add via `+` on source rows, remove (`×`), reorder (`▲`/`▼`); queue persisted under `@sonos_vnext_queue`
15. ✅ Interactive seek/scrub bar in `TransportBar` (`AVTransport:1#Seek` REL_TIME)
16. ✅ TypeScript compiles cleanly (`npx tsc --noEmit` = 0 errors)

## What Needs To Be Built Next

### Medium Priority — Polish & UX

1. **GENA Event Subscription Simulation**: `research.md` documents the large-network fallback (>20 speakers) using HTTP SUBSCRIBE + event-driven topology chunks. Simulate this with a "Large Network Mode" toggle that spawns 25+ speakers and demonstrates the 16KB buffer overflow → GENA fallback.
2. **Album Art / Track Images**: `Speaker.currentTrack.artwork` URLs exist but are only used as Unsplash placeholders. Render actual `<Image>` components in the transport bar and queue list.
3. **Responsive Layout**: The 3-pane layout uses fixed percentage widths (`24%` / flex / `24%`). On narrow screens or phones, it should collapse to a single-pane tab-based navigation.
4. **Accessibility**: Many interactive elements now have `accessibilityLabel`, but the rest of the app (channel strip headers, transport buttons, drag handles) still needs coverage and `accessibilityRole`/`accessibilityValue` annotations.
5. **Dark/Light Theme Toggle**: Currently hardcoded dark theme. Add a theme context provider.

### Low Priority — Engineering Quality

1. **Unit Tests**: No test infrastructure exists. Add Jest + React Native Testing Library. Priority test targets: `LocalFirstSyncEngine` (temporal lockout logic), `StateStore` (volume flow, zone grouping, scenes round-trip), discovery engine (topology reconciliation).
2. **Error Boundaries**: No React error boundaries exist. Add them around the main layout and transport bar.
3. **Performance**: `ChannelStrip` creates new `PanResponder` instances via `useRef` but doesn't properly update when `isOffline` changes. The `App.tsx` effect re-runs on every `selectedSpeaker` change, which triggers a new subscription cycle — this should be refactored.

## Reference Material

The file `research.md` in the project root is a fully formatted protocol reference manual containing:

- Zone 1: SSDP/mDNS multicast configs, M-SEARCH wire format, device XML parsing schema
- Zone 2: Complete UPnP SOAP request specs (Play, Pause, Stop, Next, SetAVTransportURI, GetVolume, SetVolume, GetMute, SetMute, GetZoneGroupState) with full HTTP + XML payloads
- Zone 3: Cloud API (api.ws.sonos.com) REST endpoints, OAuth2 auth, JSON schemas, WebSocket event payloads
- Zone 4: CRDT state machine math (formal tuple notation, conflict resolution matrix, ghost indicator rule, TypeScript implementation)

Use this document as the authoritative spec when implementing new features.
