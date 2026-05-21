import { WebSocketServer, WebSocket } from 'ws';
import sonosPkg from 'sonos';
import type {
  BridgeEvent,
  BridgePlayer,
  BridgeTrack,
  LogLevel,
  RpcMethod,
  RpcRequest,
  RpcResponse,
} from './protocol.js';

const { AsyncDeviceDiscovery, Sonos } = sonosPkg;
type SonosDevice = InstanceType<typeof Sonos>;

const PORT = Number(process.env.PORT ?? 8765);
const REFRESH_INTERVAL_MS = 15_000;
const DISCOVERY_TIMEOUT_MS = 6_000;

// ---------- state ----------

interface DeviceEntry {
  device: SonosDevice;
  player: BridgePlayer;
}

const devices = new Map<string, DeviceEntry>();
const clients = new Set<WebSocket>();

// ---------- helpers ----------

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

function log(level: LogLevel, protocol: 'SSDP' | 'UPnP' | 'GENA' | 'SYSTEM', message: string) {
  const prefix = `[${ts()}][${protocol}]`;
  if (level === 'error') console.error(prefix, message);
  else if (level === 'warn') console.warn(prefix, message);
  else console.log(prefix, message);
  broadcast({ kind: 'event', type: 'log', level, protocol, message });
}

function broadcast(event: BridgeEvent) {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function send(ws: WebSocket, msg: BridgeEvent | RpcResponse) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function emptyTrack(): null {
  return null;
}

function mapStatus(state: string | null | undefined): BridgePlayer['status'] {
  switch (state) {
    case 'playing':
      return 'playing';
    case 'paused':
    case 'paused_playback':
      return 'paused';
    case 'stopped':
      return 'stopped';
    case 'transitioning':
      return 'playing';
    default:
      return 'stopped';
  }
}

function safeStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function safeNum(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- player snapshot ----------

async function snapshotPlayer(device: SonosDevice, idHint?: string): Promise<BridgePlayer | null> {
  try {
    const [desc, volume, muted, state, attrs] = await Promise.allSettled([
      device.deviceDescription(),
      device.getVolume(),
      device.getMuted(),
      device.getCurrentState(),
      device.getZoneAttrs(),
    ]);

    const description: Record<string, unknown> =
      desc.status === 'fulfilled' ? (desc.value as Record<string, unknown>) ?? {} : {};
    const zoneAttrs: Record<string, unknown> =
      attrs.status === 'fulfilled' ? (attrs.value as Record<string, unknown>) ?? {} : {};

    const udn = safeStr(description.UDN ?? '').replace(/^uuid:/, '');
    const id = udn || idHint || `host-${(device as any).host}`;
    const name =
      safeStr(zoneAttrs.CurrentZoneName) ||
      safeStr(description.roomName) ||
      safeStr(description.friendlyName) ||
      `Player ${(device as any).host}`;
    const model = safeStr(description.modelDisplayName ?? description.modelName ?? 'Sonos');

    let track: BridgeTrack | null = emptyTrack();
    try {
      const t: any = await device.currentTrack();
      if (t && (t.title || t.artist || t.duration)) {
        track = {
          title: safeStr(t.title),
          artist: safeStr(t.artist),
          album: safeStr(t.album),
          artwork: safeStr(t.albumArtURI ?? t.albumArtURL ?? ''),
          duration: safeNum(t.duration),
          progress: safeNum(t.position),
        };
      }
    } catch {
      track = emptyTrack();
    }

    const player: BridgePlayer = {
      id,
      name,
      ip: (device as any).host,
      model,
      status: mapStatus(state.status === 'fulfilled' ? safeStr(state.value) : 'stopped'),
      volume: volume.status === 'fulfilled' ? safeNum(volume.value, 0) : 0,
      muted: muted.status === 'fulfilled' ? Boolean(muted.value) : false,
      bass: 0,
      treble: 0,
      loudness: false,
      nightMode: false,
      zoneCoordinatorId: id,
      zoneMemberIds: [id],
      currentTrack: track,
    };

    return player;
  } catch (err: any) {
    log('warn', 'UPnP', `Snapshot failed for ${(device as any).host}: ${err?.message ?? err}`);
    return null;
  }
}

async function refreshTopology() {
  // Pick any registered device to ask for the canonical zone group state.
  const any = devices.values().next().value;
  if (!any) return;
  try {
    const groups: any[] = await (any.device as any).getAllGroups();
    if (!Array.isArray(groups)) return;

    // groups: [{ Name, ID, Coordinator: uuid, ZoneGroupMember: [{ UUID, ZoneName, Location, ... }] }, ...]
    const coordinatorByMember = new Map<string, string>();
    const membersByCoordinator = new Map<string, string[]>();

    for (const group of groups) {
      const coordinator = safeStr(group.Coordinator);
      const members: any[] = Array.isArray(group.ZoneGroupMember)
        ? group.ZoneGroupMember
        : [];
      const memberIds = members.map((m) => safeStr(m.UUID));
      membersByCoordinator.set(coordinator, memberIds);
      for (const id of memberIds) coordinatorByMember.set(id, coordinator);
    }

    for (const [id, entry] of devices) {
      const coord = coordinatorByMember.get(id) ?? id;
      entry.player.zoneCoordinatorId = coord;
      entry.player.zoneMemberIds = membersByCoordinator.get(coord) ?? [id];
    }
  } catch (err: any) {
    log('warn', 'UPnP', `getAllGroups failed: ${err?.message ?? err}`);
  }
}

function snapshotsToProtocol(): BridgePlayer[] {
  return Array.from(devices.values()).map((e) => e.player);
}

function broadcastTopology() {
  broadcast({ kind: 'event', type: 'topology', players: snapshotsToProtocol() });
}

// ---------- discovery + attach ----------

function attachEventListeners(entry: DeviceEntry) {
  const { device, player } = entry;
  try {
    device.on('Volume', (v: number) => {
      player.volume = safeNum(v, player.volume);
      broadcast({
        kind: 'event',
        type: 'player.volume',
        playerId: player.id,
        volume: player.volume,
        muted: player.muted,
      });
    });
    device.on('Muted', (m: boolean) => {
      player.muted = Boolean(m);
      broadcast({
        kind: 'event',
        type: 'player.volume',
        playerId: player.id,
        volume: player.volume,
        muted: player.muted,
      });
    });
    device.on('PlayState', (state: string) => {
      player.status = mapStatus(state);
      broadcast({
        kind: 'event',
        type: 'player.transport',
        playerId: player.id,
        status: player.status,
        currentTrack: player.currentTrack,
      });
    });
    device.on('CurrentTrack', (t: any) => {
      if (t && (t.title || t.artist)) {
        player.currentTrack = {
          title: safeStr(t.title),
          artist: safeStr(t.artist),
          album: safeStr(t.album),
          artwork: safeStr(t.albumArtURI ?? t.albumArtURL ?? ''),
          duration: safeNum(t.duration),
          progress: safeNum(t.position),
        };
      } else {
        player.currentTrack = null;
      }
      broadcast({
        kind: 'event',
        type: 'player.transport',
        playerId: player.id,
        status: player.status,
        currentTrack: player.currentTrack,
      });
    });
  } catch (err: any) {
    log('warn', 'GENA', `Event subscription failed for ${player.name}: ${err?.message ?? err}`);
  }
}

async function registerDevice(device: SonosDevice) {
  const snap = await snapshotPlayer(device);
  if (!snap) return;
  if (devices.has(snap.id)) {
    devices.get(snap.id)!.player = snap;
    return;
  }
  const entry: DeviceEntry = { device, player: snap };
  devices.set(snap.id, entry);
  attachEventListeners(entry);
  log('success', 'SSDP', `Registered ${snap.name} (${snap.model}) at ${snap.ip} [${snap.id}]`);
}

async function runDiscovery(): Promise<void> {
  log('info', 'SSDP', 'Multicast M-SEARCH urn:schemas-upnp-org:device:ZonePlayer:1');
  const disco = new AsyncDeviceDiscovery();
  // The lib emits DeviceAvailable for each device found over the timeout window.
  await new Promise<void>((resolve) => {
    const found = new Set<string>();
    const onDevice = async (device: SonosDevice) => {
      const host = (device as any).host;
      if (found.has(host)) return;
      found.add(host);
      try {
        await registerDevice(device);
      } catch (err: any) {
        log('warn', 'SSDP', `Failed to register ${host}: ${err?.message ?? err}`);
      }
    };
    (disco as any).on?.('DeviceAvailable', onDevice);
    // Fallback for libs that only expose .discover()
    (disco as any)
      .discover?.({ timeout: DISCOVERY_TIMEOUT_MS })
      ?.then?.((device: SonosDevice) => onDevice(device))
      ?.catch?.(() => {});
    setTimeout(resolve, DISCOVERY_TIMEOUT_MS + 200);
  });

  await refreshTopology();
  broadcastTopology();
  log('info', 'SSDP', `Discovery sweep complete: ${devices.size} players`);
}

// ---------- RPC dispatch ----------

function paramStr(params: any, key: string): string {
  const v = params?.[key];
  if (typeof v !== 'string') throw new Error(`missing string param: ${key}`);
  return v;
}

function paramNum(params: any, key: string): number {
  const v = params?.[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`missing number param: ${key}`);
  return v;
}

function paramBool(params: any, key: string): boolean {
  const v = params?.[key];
  if (typeof v !== 'boolean') throw new Error(`missing boolean param: ${key}`);
  return v;
}

function getDevice(playerId: string): SonosDevice {
  const entry = devices.get(playerId);
  if (!entry) throw new Error(`unknown playerId: ${playerId}`);
  return entry.device;
}

async function dispatch(method: RpcMethod, params: Record<string, unknown> | undefined): Promise<unknown> {
  switch (method) {
    case 'discovery.refresh': {
      await runDiscovery();
      return { players: snapshotsToProtocol().length };
    }
    case 'player.setVolume': {
      const id = paramStr(params, 'playerId');
      const volume = paramNum(params, 'volume');
      await getDevice(id).setVolume(Math.max(0, Math.min(100, Math.round(volume))));
      const entry = devices.get(id)!;
      entry.player.volume = volume;
      return { ok: true };
    }
    case 'player.setMute': {
      const id = paramStr(params, 'playerId');
      const muted = paramBool(params, 'muted');
      await getDevice(id).setMuted(muted);
      devices.get(id)!.player.muted = muted;
      return { ok: true };
    }
    case 'player.setEQ': {
      const id = paramStr(params, 'playerId');
      const bass = paramNum(params, 'bass');
      const treble = paramNum(params, 'treble');
      const loudness = paramBool(params, 'loudness');
      const nightMode = paramBool(params, 'nightMode');
      const device: any = getDevice(id);
      const svc = device.renderingControlService?.();
      if (!svc) throw new Error('RenderingControl service unavailable');
      await svc.SetBass({ InstanceID: 0, DesiredBass: bass });
      await svc.SetTreble({ InstanceID: 0, DesiredTreble: treble });
      await svc.SetLoudness({ InstanceID: 0, Channel: 'Master', DesiredLoudness: loudness });
      // Night mode is RenderingControl#SetEQ with EQType=NightMode (1/0).
      try {
        await svc.SetEQ({ InstanceID: 0, EQType: 'NightMode', DesiredValue: nightMode ? 1 : 0 });
      } catch {
        /* not all models support */
      }
      const entry = devices.get(id)!;
      entry.player.bass = bass;
      entry.player.treble = treble;
      entry.player.loudness = loudness;
      entry.player.nightMode = nightMode;
      return { ok: true };
    }
    case 'transport.play': {
      await getDevice(paramStr(params, 'playerId')).play();
      return { ok: true };
    }
    case 'transport.pause': {
      await getDevice(paramStr(params, 'playerId')).pause();
      return { ok: true };
    }
    case 'transport.seek': {
      const id = paramStr(params, 'playerId');
      const seconds = paramNum(params, 'seconds');
      await getDevice(id).seek(Math.max(0, Math.round(seconds)));
      return { ok: true };
    }
    case 'transport.next': {
      await getDevice(paramStr(params, 'playerId')).next();
      return { ok: true };
    }
    case 'transport.prev': {
      await (getDevice(paramStr(params, 'playerId')) as any).previous();
      return { ok: true };
    }
    case 'zone.group': {
      const coordinatorId = paramStr(params, 'coordinatorId');
      const memberId = paramStr(params, 'memberId');
      const coordinator = devices.get(coordinatorId);
      if (!coordinator) throw new Error(`unknown coordinatorId: ${coordinatorId}`);
      const member: any = getDevice(memberId);
      await member.joinGroup(coordinator.player.name);
      await refreshTopology();
      broadcastTopology();
      return { ok: true };
    }
    case 'zone.ungroup': {
      const id = paramStr(params, 'playerId');
      const device: any = getDevice(id);
      await device.leaveGroup();
      await refreshTopology();
      broadcastTopology();
      return { ok: true };
    }
    default: {
      throw new Error(`unknown method: ${method}`);
    }
  }
}

// ---------- WebSocket server ----------

const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });

wss.on('listening', () => {
  log('info', 'SYSTEM', `Bridge WebSocket listening on ws://localhost:${PORT}`);
});

wss.on('connection', (ws, req) => {
  clients.add(ws);
  log('info', 'SYSTEM', `Client connected from ${req.socket.remoteAddress}`);
  // Immediately send current topology so the UI shows what we already know.
  send(ws, { kind: 'event', type: 'topology', players: snapshotsToProtocol() });

  ws.on('message', async (raw) => {
    let parsed: RpcRequest;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send(ws, { kind: 'rpc-response', id: 'unknown', ok: false, error: 'invalid JSON' });
      return;
    }
    if (parsed?.kind !== 'rpc' || !parsed.method || !parsed.id) {
      send(ws, {
        kind: 'rpc-response',
        id: parsed?.id ?? 'unknown',
        ok: false,
        error: 'invalid request envelope',
      });
      return;
    }
    try {
      const result = await dispatch(parsed.method, parsed.params);
      send(ws, { kind: 'rpc-response', id: parsed.id, ok: true, result });
    } catch (err: any) {
      log('warn', 'UPnP', `RPC ${parsed.method} failed: ${err?.message ?? err}`);
      send(ws, {
        kind: 'rpc-response',
        id: parsed.id,
        ok: false,
        error: err?.message ?? String(err),
      });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    log('info', 'SYSTEM', 'Client disconnected');
  });
});

// ---------- boot ----------

async function boot() {
  log('info', 'SYSTEM', `sonos-vnext bridge starting (node ${process.version})`);
  await runDiscovery();
  setInterval(() => {
    runDiscovery().catch((err) =>
      log('warn', 'SSDP', `Periodic discovery error: ${err?.message ?? err}`),
    );
  }, REFRESH_INTERVAL_MS);
}

boot().catch((err) => {
  log('error', 'SYSTEM', `Boot failed: ${err?.message ?? err}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  log('info', 'SYSTEM', 'SIGINT received - shutting down');
  wss.close(() => process.exit(0));
});
