import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff, X } from 'lucide-preact';
import { useEffect, useRef } from 'preact/hooks';
import { Avatar } from '../chat/Avatar.tsx';
import { useCalls } from './CallProvider.tsx';
import type { CallRoute, RemoteView } from './engine.ts';

const ROUTE_TEXT: Record<CallRoute, string> = {
  direct: 'Соединение напрямую',
  tailnet: 'Соединение через Tailscale',
  relay: 'Соединение через ретранслятор',
};

const LINK_TEXT: Record<RemoteView['link'], string> = {
  connecting: 'Соединяемся…',
  connected: '',
  unstable: 'Связь нестабильна…',
  failed: 'Соединение потеряно',
};

/** Plays a stream; the local preview is muted so that nobody hears themselves. */
function StreamView(props: {
  stream: MediaStream | null;
  muted?: boolean;
  mirrored?: boolean;
  label: string;
  class: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element && element.srcObject !== props.stream) element.srcObject = props.stream;
  }, [props.stream]);
  return (
    <video
      ref={ref}
      class={props.mirrored ? `${props.class} call__video--mirrored` : props.class}
      autoplay
      playsInline
      muted={props.muted === true}
      aria-label={props.label}
    />
  );
}

function hasVideo(stream: MediaStream | null): boolean {
  return stream?.getVideoTracks().some((track) => track.readyState === 'live' && track.enabled) ?? false;
}

function Incoming() {
  const { state, accept, decline } = useCalls();
  const call = state.call;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button[data-accept]')?.focus();
  }, []);
  if (!call) return null;
  return (
    <div
      class="call-incoming"
      role="alertdialog"
      aria-labelledby="call-in-title"
      aria-describedby="call-in-text"
      ref={ref}
    >
      <Avatar id={call.initiator.id} name={call.initiator.displayName} size="lg" />
      <div class="call-incoming__text">
        <p id="call-in-title" class="call-incoming__title">
          {call.initiator.displayName}
        </p>
        <p id="call-in-text" class="call-incoming__sub">
          {call.video ? 'Видеозвонок' : 'Голосовой звонок'}
        </p>
        {state.message ? (
          <p class="call-incoming__problem" role="alert">
            {state.message}
          </p>
        ) : null}
      </div>
      <div class="call-incoming__actions">
        <button type="button" class="button call-btn call-btn--accept" data-accept onClick={accept}>
          <Phone size={20} aria-hidden="true" />
          Принять
        </button>
        <button type="button" class="button call-btn call-btn--decline" onClick={decline}>
          <PhoneOff size={20} aria-hidden="true" />
          Отклонить
        </button>
      </div>
    </div>
  );
}

function Screen() {
  const { state, hangup, toggleMute, toggleCamera } = useCalls();
  const call = state.call;
  if (!call) return null;
  const others = call.participants.filter(
    (p) => p.id !== call.initiator.id || state.remotes.some((r) => r.userId === p.id),
  );
  const waiting = state.phase === 'outgoing';
  const names = others.length > 0 ? others.map((p) => p.displayName).join(', ') : call.initiator.displayName;
  const first = state.remotes[0];
  const status =
    state.phase === 'outgoing'
      ? 'Вызываем…'
      : state.phase === 'connecting' || state.phase === 'starting'
        ? 'Соединяемся…'
        : state.remotes.length === 0
          ? 'Ждём собеседника…'
          : (first && LINK_TEXT[first.link]) || (first?.route ? ROUTE_TEXT[first.route] : 'Идёт разговор');
  const showSelf = state.video && state.local !== null && !state.cameraOff;
  return (
    <section class="call" aria-label={`Звонок: ${names}`}>
      <header class="call__bar">
        <p class="call__name">{names}</p>
        <p class="call__status" role="status">
          {status}
        </p>
      </header>
      {state.message ? (
        <p class="call__problem" role="alert">
          {state.message}
        </p>
      ) : null}
      <div class={`call__grid call__grid--${Math.min(Math.max(state.remotes.length, 1), 4)}`}>
        {state.remotes.length === 0 ? (
          <div class="call__waiting">
            <Avatar id={call.participants[1]?.id ?? call.initiator.id} name={names} size="xl" />
            <p>{waiting ? 'Ждём ответа…' : 'Соединяемся…'}</p>
          </div>
        ) : (
          state.remotes.map((remote) => (
            <div key={remote.userId} class="call__tile">
              <StreamView stream={remote.stream} label={remote.name} class="call__video" />
              {!hasVideo(remote.stream) ? (
                <div class="call__poster">
                  <Avatar id={remote.userId} name={remote.name} size="xl" />
                </div>
              ) : null}
              <p class="call__tag">{remote.name}</p>
            </div>
          ))
        )}
      </div>
      {showSelf ? (
        <div class="call__self">
          <StreamView stream={state.local} muted mirrored label="Вы" class="call__video" />
        </div>
      ) : null}
      <div class="call__controls">
        <button
          type="button"
          class={state.muted ? 'call-round call-round--off' : 'call-round'}
          aria-pressed={state.muted}
          onClick={toggleMute}
        >
          {state.muted ? <MicOff size={24} aria-hidden="true" /> : <Mic size={24} aria-hidden="true" />}
          <span>{state.muted ? 'Включить звук' : 'Выключить звук'}</span>
        </button>
        {state.video ? (
          <button
            type="button"
            class={state.cameraOff ? 'call-round call-round--off' : 'call-round'}
            aria-pressed={state.cameraOff}
            onClick={toggleCamera}
          >
            {state.cameraOff ? (
              <VideoOff size={24} aria-hidden="true" />
            ) : (
              <Video size={24} aria-hidden="true" />
            )}
            <span>{state.cameraOff ? 'Включить камеру' : 'Выключить камеру'}</span>
          </button>
        ) : null}
        <button type="button" class="call-round call-round--hangup" onClick={hangup}>
          <PhoneOff size={24} aria-hidden="true" />
          <span>Завершить</span>
        </button>
      </div>
    </section>
  );
}

/** Everything about a call that must appear above the pages: ringing, the call screen, the end note. */
export function CallOverlay() {
  const { state, dismissMessage } = useCalls();
  if (state.phase === 'incoming') return <Incoming />;
  if (
    state.phase === 'starting' ||
    state.phase === 'outgoing' ||
    state.phase === 'connecting' ||
    state.phase === 'active'
  ) {
    return <Screen />;
  }
  if (state.phase === 'ended' && state.endedText) {
    return (
      <p class="call-note" role="status">
        {state.endedText}
      </p>
    );
  }
  if (state.message) {
    return (
      <div class="call-note call-note--problem" role="alert">
        <p>{state.message}</p>
        <button type="button" class="call-note__close" onClick={dismissMessage}>
          <X size={18} aria-hidden="true" />
          <span class="visually-hidden">Закрыть сообщение</span>
        </button>
      </div>
    );
  }
  return null;
}
