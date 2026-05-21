import {
  BridgeEvent,
  BridgeMessage,
  BridgePlayer,
  RpcMethod,
  RpcRequest,
  RpcResponse,
} from './bridgeProtocol';

export type BridgeStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_URL = 'ws://localhost:8765';
const RPC_TIMEOUT_MS = 8000;
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

export class BridgeClient {
  private url: string;
  private ws: WebSocket | null = null;
  private status: BridgeStatus = 'idle';
  private statusListeners = new Set<(status: BridgeStatus) => void>();
  private topologyListeners = new Set<(players: BridgePlayer[]) => void>();
  private eventListeners = new Set<(event: BridgeEvent) => void>();
  private pending = new Map<string, PendingCall>();
  private backoff = MIN_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(url: string = DEFAULT_URL) {
    this.url = url;
  }

  getStatus(): BridgeStatus {
    return this.status;
  }

  connect() {
    this.stopped = false;
    this.open();
  }

  disconnect() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  reconnectNow() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.backoff = MIN_BACKOFF_MS;
    this.open();
  }

  subscribeStatus(cb: (status: BridgeStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  subscribeTopology(cb: (players: BridgePlayer[]) => void): () => void {
    this.topologyListeners.add(cb);
    return () => {
      this.topologyListeners.delete(cb);
    };
  }

  subscribeEvents(cb: (event: BridgeEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  async rpc<T = unknown>(method: RpcMethod, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('bridge not connected');
    }
    const id = 'tx-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const request: RpcRequest = { kind: 'rpc', id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge RPC ${method} timed out`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      try {
        this.ws!.send(JSON.stringify(request));
      } catch (err: any) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ---------- internal ----------

  private setStatus(next: BridgeStatus) {
    if (this.status === next) return;
    this.status = next;
    for (const cb of this.statusListeners) cb(next);
  }

  private open() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = MIN_BACKOFF_MS;
      this.setStatus('connected');
    };

    ws.onmessage = (ev) => {
      this.handleMessage(ev.data);
    };

    ws.onerror = () => {
      // browsers close after onerror; the onclose will trigger reconnect
    };

    ws.onclose = () => {
      this.failPending(new Error('bridge connection closed'));
      this.ws = null;
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private handleMessage(data: unknown) {
    let parsed: BridgeMessage;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (parsed.kind === 'rpc-response') {
      this.handleRpcResponse(parsed);
      return;
    }
    if (parsed.kind === 'event') {
      this.handleEvent(parsed);
    }
  }

  private handleRpcResponse(resp: RpcResponse) {
    const pending = this.pending.get(resp.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(resp.id);
    if (resp.ok) pending.resolve(resp.result);
    else pending.reject(new Error(resp.error ?? 'bridge RPC failed'));
  }

  private handleEvent(event: BridgeEvent) {
    if (event.type === 'topology') {
      for (const cb of this.topologyListeners) cb(event.players);
    }
    for (const cb of this.eventListeners) cb(event);
  }

  private failPending(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export const bridgeClient = new BridgeClient();
