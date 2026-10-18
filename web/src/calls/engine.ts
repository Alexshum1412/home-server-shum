/**
 * The device side of a call (WebRTC). The server only introduces the devices; sound and picture go
 * straight between them, encrypted by the browser (DTLS-SRTP).
 *
 * Roles are fixed so that two devices never offer at the same moment: whoever joins a call sends an
 * offer to everybody who is already in it, the others answer. A call of up to four people is a mesh
 * (everyone talks to everyone), which is why the server stops at four.
 */
import type {
  CallConfigResponse,
  CallEndReason,
  CallInfo,
  RealtimeEvent,
  SignalType,
} from '../../../shared/api.ts';
import { ApiFailure, apiGet, apiPost, NO_CONNECTION, toFailure } from '../api.ts';

export type CallPhase = 'idle' | 'starting' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';
export type CallRoute = 'direct' | 'tailnet' | 'relay';

export interface RemoteView {
  userId: string;
  name: string;
  stream: MediaStream;
  link: 'connecting' | 'connected' | 'unstable' | 'failed';
  route: CallRoute | null;
}

export interface CallViewState {
  phase: CallPhase;
  call: CallInfo | null;
  video: boolean;
  muted: boolean;
  cameraOff: boolean;
  local: MediaStream | null;
  remotes: RemoteView[];
  /** A problem or hint to show the person (Russian, with the next step). */
  message: string | null;
  /** Why the call ended, for the short farewell line. */
  endedText: string | null;
  relay: CallConfigResponse['relay'];
}

const IDLE: CallViewState = {
  phase: 'idle',
  call: null,
  video: false,
  muted: false,
  cameraOff: false,
  local: null,
  remotes: [],
  message: null,
  endedText: null,
  relay: 'none',
};

interface Peer {
  userId: string;
  connection: RTCPeerConnection;
  stream: MediaStream;
  remoteReady: boolean;
  queue: RTCIceCandidateInit[];
  link: RemoteView['link'];
  route: CallRoute | null;
  restarted: boolean;
  weOffer: boolean;
}

const END_TEXT: Record<CallEndReason, string> = {
  hangup: 'Звонок завершён.',
  declined: 'Звонок отклонён.',
  missed: 'Никто не ответил.',
  cancelled: 'Звонок отменён.',
  busy: 'Собеседник уже разговаривает. Позвоните чуть позже.',
  failed: 'Не удалось соединиться.',
};

/** Why getUserMedia failed, as a sentence with the next step. */
export function mediaProblem(error: unknown, video: boolean): string {
  const device = video ? 'камере и микрофону' : 'микрофону';
  const name = (error as { name?: string } | null)?.name ?? '';
  if (!navigator.mediaDevices?.getUserMedia) {
    return window.isSecureContext
      ? 'Этот браузер не умеет звонить. Откройте портал в Chrome, Edge, Firefox или Safari.'
      : 'Звонки работают только по защищённому адресу (https://…). Откройте портал по адресу «Подключение» → Tailscale, а не по адресу домашней сети.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return `Нет доступа к ${device}. Нажмите на значок замка рядом с адресом, разрешите доступ и повторите.`;
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return video
      ? 'Не найдена камера или микрофон. Подключите их и повторите.'
      : 'Не найден микрофон. Подключите его и повторите.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return `${video ? 'Камера или микрофон заняты' : 'Микрофон занят'} другой программой. Закройте её и повторите.`;
  }
  return `Не удалось включить ${video ? 'камеру и микрофон' : 'микрофон'}. Проверьте разрешения и повторите.`;
}

function routeOf(type: string | undefined, address: string | undefined): CallRoute {
  if (type === 'relay') return 'relay';
  // 100.64.0.0/10 is the Tailscale range.
  const match = /^100\.(\d+)\./.exec(address ?? '');
  if (match && Number(match[1]) >= 64 && Number(match[1]) <= 127) return 'tailnet';
  return 'direct';
}

export interface CallEngineHooks {
  /** Plays/stops the ringing sound and vibration. */
  ring: (kind: 'incoming' | 'outgoing' | null) => void;
}

export class CallEngine {
  private state: CallViewState = IDLE;
  private readonly listeners = new Set<() => void>();
  private readonly peers = new Map<string, Peer>();
  private local: MediaStream | null = null;
  private iceServers: RTCIceServer[] = [];
  private endTimer: ReturnType<typeof setTimeout> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private lastSignalFailure = 0;

  constructor(
    private readonly myId: () => string,
    private readonly hooks: CallEngineHooks,
  ) {}

  // --- state -------------------------------------------------------------------------------

  getState = (): CallViewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<CallViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private publishRemotes(): void {
    const names = new Map(this.state.call?.participants.map((p) => [p.id, p.displayName]));
    this.set({
      remotes: [...this.peers.values()].map((peer) => ({
        userId: peer.userId,
        name: names.get(peer.userId) ?? 'Собеседник',
        stream: peer.stream,
        link: peer.link,
        route: peer.route,
      })),
    });
  }

  // --- media -------------------------------------------------------------------------------

  private async openMedia(video: boolean): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia)
      throw Object.assign(new Error('no media'), { name: 'NoMediaDevices' });
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video
        ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 }, facingMode: 'user' }
        : false,
    });
  }

  private stopMedia(): void {
    for (const track of this.local?.getTracks() ?? []) track.stop();
    this.local = null;
  }

  private async loadIce(): Promise<void> {
    const config = await apiGet<CallConfigResponse>('/api/calls/config');
    this.iceServers = config.iceServers.map((server) => ({
      urls: server.urls,
      ...(server.username ? { username: server.username } : {}),
      ...(server.credential ? { credential: server.credential } : {}),
    }));
    this.set({ relay: config.relay });
  }

  // --- starting, answering, ending -----------------------------------------------------------

  async start(conversationId: string, video: boolean): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'ended') return;
    clearTimeout(this.endTimer);
    this.set({ ...IDLE, phase: 'starting', video });
    try {
      this.local = await this.openMedia(video);
    } catch (error) {
      this.set({ ...IDLE, message: mediaProblem(error, video) });
      return;
    }
    try {
      await this.loadIce();
      const started = await apiPost<{ call: CallInfo; busy: string[] }>('/api/calls', {
        conversationId,
        video,
      });
      this.set({ call: started.call, local: this.local, cameraOff: false, muted: false });
      if (started.call.state === 'ended') {
        this.finish(started.call);
        return;
      }
      this.set({ phase: 'outgoing' });
      this.hooks.ring('outgoing');
    } catch (error) {
      this.stopMedia();
      this.set({ ...IDLE, message: this.explain(error) });
    }
  }

  async accept(): Promise<void> {
    const call = this.state.call;
    if (this.state.phase !== 'incoming' || !call) return;
    this.hooks.ring(null);
    this.set({ phase: 'connecting', message: null });
    try {
      this.local = await this.openMedia(call.video);
    } catch (error) {
      // Stay on the ringing screen: the person can fix the permission and press «Принять» again.
      this.set({ phase: 'incoming', message: mediaProblem(error, call.video) });
      this.hooks.ring('incoming');
      return;
    }
    this.set({ local: this.local, muted: false, cameraOff: false, video: call.video });
    try {
      await this.loadIce();
      const joined = await apiPost<{ call: CallInfo; peers: string[] }>(`/api/calls/${call.id}/join`);
      this.set({ call: joined.call });
      for (const id of joined.peers) await this.connectTo(id, true);
      if (joined.peers.length === 0) this.set({ phase: 'connecting' });
    } catch (error) {
      this.stopMedia();
      this.closePeers();
      this.set({ ...IDLE, message: this.explain(error) });
    }
  }

  async decline(): Promise<void> {
    const call = this.state.call;
    if (this.state.phase !== 'incoming' || !call) return;
    this.hooks.ring(null);
    this.set({ ...IDLE });
    try {
      await apiPost(`/api/calls/${call.id}/decline`);
    } catch {
      // the call may have ended already
    }
  }

  async hangup(): Promise<void> {
    const call = this.state.call;
    if (!call || this.state.phase === 'idle' || this.state.phase === 'ended') return;
    this.hooks.ring(null);
    this.closePeers();
    this.stopMedia();
    this.set({ ...IDLE });
    try {
      await apiPost(`/api/calls/${call.id}/leave`);
    } catch {
      // the server drops an absent person by itself
    }
  }

  /** Leaves with the page (closing a tab): best effort, the server also notices a vanished device. */
  leaveQuietly(): void {
    const call = this.state.call;
    if (!call || this.state.phase === 'idle' || this.state.phase === 'ended') return;
    try {
      void fetch(`/api/calls/${call.id}/leave`, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch {
      // nothing more can be done while closing
    }
  }

  clearMessage(): void {
    if (this.state.message !== null) this.set({ message: null });
  }

  toggleMute(): void {
    const muted = !this.state.muted;
    for (const track of this.local?.getAudioTracks() ?? []) track.enabled = !muted;
    this.set({ muted });
  }

  toggleCamera(): void {
    const cameraOff = !this.state.cameraOff;
    for (const track of this.local?.getVideoTracks() ?? []) track.enabled = !cameraOff;
    this.set({ cameraOff });
  }

  private explain(error: unknown): string {
    const failure = toFailure(error);
    if (failure.unreachable) return `${NO_CONNECTION}. Звонок не начался.`;
    if (failure instanceof ApiFailure && failure.message) return failure.message;
    return 'Не удалось начать звонок.';
  }

  // --- live events ---------------------------------------------------------------------------

  handle(event: RealtimeEvent): void {
    if (event.type === 'hello') {
      void this.resume();
      return;
    }
    if (event.type === 'call') this.onCall(event.call);
    else if (event.type === 'signal') void this.onSignal(event.callId, event.from, event.signal, event.data);
  }

  /** After a reload or a lost connection: what does the server say about my call? */
  async resume(): Promise<void> {
    let active: CallInfo | null = null;
    try {
      active = (await apiGet<{ call: CallInfo | null }>('/api/calls/active')).call;
    } catch {
      return;
    }
    const phase = this.state.phase;
    if (active === null) {
      if (phase === 'incoming' || phase === 'outgoing' || phase === 'connecting' || phase === 'active') {
        this.hooks.ring(null);
        this.closePeers();
        this.stopMedia();
        this.set({ ...IDLE, message: 'Звонок уже закончился.' });
      }
      return;
    }
    const me = this.myId();
    const mine = active.participants.find((p) => p.id === me);
    if (phase === 'idle') {
      if (mine?.joined) {
        // This page was reloaded in the middle of a call: the devices cannot pick it up again.
        try {
          await apiPost(`/api/calls/${active.id}/leave`);
        } catch {
          // dropped by the server soon anyway
        }
        this.set({ message: 'Звонок прервался, потому что страница перезагрузилась. Позвоните ещё раз.' });
      } else if (active.state === 'ringing' && active.initiator.id !== me && !mine?.declined) {
        this.ringIncoming(active);
      }
    }
  }

  private ringIncoming(call: CallInfo): void {
    clearTimeout(this.endTimer);
    this.set({ ...IDLE, phase: 'incoming', call, video: call.video, message: null });
    this.hooks.ring('incoming');
  }

  private onCall(call: CallInfo): void {
    const me = this.myId();
    const current = this.state.call;
    if (current && current.id === call.id) {
      if (call.state === 'ended') {
        this.finish(call);
        return;
      }
      this.set({ call });
      // Somebody left a call that goes on: drop their connection.
      for (const [userId, peer] of [...this.peers]) {
        const person = call.participants.find((p) => p.id === userId);
        if (person && !person.joined) {
          this.closePeer(peer);
          this.peers.delete(userId);
        }
      }
      this.publishRemotes();
      if (this.state.phase === 'outgoing' && call.participants.some((p) => p.id !== me && p.joined)) {
        this.hooks.ring(null);
        this.set({ phase: 'connecting' });
      }
      return;
    }
    if (call.state === 'ended' || (this.state.phase !== 'idle' && this.state.phase !== 'ended')) return;
    const mine = call.participants.find((p) => p.id === me);
    if (call.state === 'ringing' && call.initiator.id !== me && mine && !mine.joined && !mine.declined) {
      this.ringIncoming(call);
    }
  }

  private finish(call: CallInfo): void {
    this.hooks.ring(null);
    this.closePeers();
    this.stopMedia();
    const text = END_TEXT[call.endReason ?? 'hangup'];
    this.set({ ...IDLE, phase: 'ended', call, endedText: text });
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => {
      if (this.state.phase === 'ended') this.set({ ...IDLE });
    }, 4000);
  }

  // --- peer connections ----------------------------------------------------------------------

  private async connectTo(userId: string, weOffer: boolean): Promise<Peer> {
    const existing = this.peers.get(userId);
    if (existing) return existing;
    const connection = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = {
      userId,
      connection,
      stream: new MediaStream(),
      remoteReady: false,
      queue: [],
      link: 'connecting',
      route: null,
      restarted: false,
      weOffer,
    };
    this.peers.set(userId, peer);
    for (const track of this.local?.getTracks() ?? []) {
      connection.addTrack(track, this.local as MediaStream);
    }
    connection.onicecandidate = (event) => {
      if (event.candidate) void this.send(userId, 'candidate', event.candidate.toJSON());
    };
    connection.ontrack = (event) => {
      if (!peer.stream.getTracks().includes(event.track)) peer.stream.addTrack(event.track);
      this.publishRemotes();
    };
    connection.onconnectionstatechange = () => this.onLinkState(peer);
    if (weOffer) await this.offer(peer);
    this.publishRemotes();
    return peer;
  }

  private async offer(peer: Peer, iceRestart = false): Promise<void> {
    const description = await peer.connection.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await peer.connection.setLocalDescription(description);
    await this.send(peer.userId, 'offer', {
      type: 'offer',
      sdp: peer.connection.localDescription?.sdp ?? description.sdp,
    });
  }

  private async onSignal(callId: string, from: string, type: SignalType, data: unknown): Promise<void> {
    const call = this.state.call;
    const phase = this.state.phase;
    if (!call || call.id !== callId || phase === 'idle' || phase === 'ended' || phase === 'incoming') return;
    try {
      if (type === 'offer') {
        const peer = this.peers.get(from) ?? (await this.connectTo(from, false));
        await peer.connection.setRemoteDescription(data as RTCSessionDescriptionInit);
        peer.remoteReady = true;
        await this.flush(peer);
        const answer = await peer.connection.createAnswer();
        await peer.connection.setLocalDescription(answer);
        await this.send(from, 'answer', {
          type: 'answer',
          sdp: peer.connection.localDescription?.sdp ?? answer.sdp,
        });
        if (this.state.phase === 'outgoing') {
          this.hooks.ring(null);
          this.set({ phase: 'connecting' });
        }
      } else if (type === 'answer') {
        const peer = this.peers.get(from);
        if (!peer) return;
        await peer.connection.setRemoteDescription(data as RTCSessionDescriptionInit);
        peer.remoteReady = true;
        await this.flush(peer);
      } else {
        const peer = this.peers.get(from);
        if (!peer) return;
        if (peer.remoteReady) await peer.connection.addIceCandidate(data as RTCIceCandidateInit);
        else peer.queue.push(data as RTCIceCandidateInit);
      }
    } catch (error) {
      console.warn('Сообщение для соединения не принято', error);
    }
  }

  private async flush(peer: Peer): Promise<void> {
    const queued = peer.queue.splice(0);
    for (const candidate of queued) {
      try {
        await peer.connection.addIceCandidate(candidate);
      } catch {
        // an old or foreign candidate
      }
    }
  }

  private async send(to: string, type: SignalType, data: unknown): Promise<void> {
    const call = this.state.call;
    if (!call) return;
    try {
      await apiPost(`/api/calls/${call.id}/signal`, { to, type, data });
    } catch (error) {
      // Candidates arrive in bursts; one warning a few seconds is enough.
      if (Date.now() - this.lastSignalFailure > 5000) {
        this.lastSignalFailure = Date.now();
        console.warn('Не удалось передать сообщение собеседнику', error);
      }
    }
  }

  private onLinkState(peer: Peer): void {
    const state = peer.connection.connectionState;
    if (state === 'connected') {
      peer.link = 'connected';
      if (this.state.phase === 'connecting' || this.state.phase === 'outgoing') {
        this.hooks.ring(null);
        this.set({ phase: 'active', message: null });
      }
      void this.detectRoute(peer);
      this.startStats();
    } else if (state === 'disconnected') {
      peer.link = 'unstable';
      // Short breaks mend themselves; the offering side asks for fresh network paths after a moment.
      setTimeout(() => {
        if (peer.connection.connectionState === 'disconnected' && peer.weOffer && !peer.restarted) {
          peer.restarted = true;
          void this.offer(peer, true);
        }
      }, 3000);
    } else if (state === 'failed') {
      if (peer.weOffer && !peer.restarted) {
        peer.restarted = true;
        peer.link = 'unstable';
        void this.offer(peer, true);
      } else {
        peer.link = 'failed';
        this.set({ message: this.failureHint() });
      }
    }
    this.publishRemotes();
  }

  private failureHint(): string {
    const hint =
      this.state.relay === 'turn'
        ? ''
        : ' Включите Tailscale на обоих устройствах: через него звонок соединяется напрямую.';
    return `Не удаётся соединиться с собеседником.${hint}`;
  }

  private async detectRoute(peer: Peer): Promise<void> {
    try {
      const stats = await peer.connection.getStats();
      let pair: Record<string, unknown> | undefined;
      const all = new Map<string, Record<string, unknown>>();
      stats.forEach((report: Record<string, unknown>) => {
        all.set(String(report.id), report);
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          pair = all.get(String(report.selectedCandidatePairId)) ?? pair;
        }
      });
      if (!pair) {
        stats.forEach((report: Record<string, unknown>) => {
          if (report.type === 'candidate-pair' && report.nominated === true && report.state === 'succeeded')
            pair = report;
        });
      }
      if (!pair) return;
      const remote = all.get(String(pair.remoteCandidateId));
      const local = all.get(String(pair.localCandidateId));
      const type = (remote?.candidateType ?? local?.candidateType) as string | undefined;
      const address = (remote?.address ?? remote?.ip) as string | undefined;
      peer.route = routeOf(local?.candidateType === 'relay' ? 'relay' : type, address);
      this.publishRemotes();
    } catch {
      // statistics are a nicety
    }
  }

  private startStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      if (this.peers.size === 0) {
        clearInterval(this.statsTimer);
        this.statsTimer = undefined;
        return;
      }
      for (const peer of this.peers.values()) if (peer.link === 'connected') void this.detectRoute(peer);
    }, 10_000);
  }

  private closePeer(peer: Peer): void {
    peer.connection.onicecandidate = null;
    peer.connection.ontrack = null;
    peer.connection.onconnectionstatechange = null;
    peer.connection.close();
  }

  private closePeers(): void {
    for (const peer of this.peers.values()) this.closePeer(peer);
    this.peers.clear();
    clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    this.state = { ...this.state, remotes: [] };
  }

  dispose(): void {
    clearTimeout(this.endTimer);
    this.hooks.ring(null);
    this.closePeers();
    this.stopMedia();
  }
}
