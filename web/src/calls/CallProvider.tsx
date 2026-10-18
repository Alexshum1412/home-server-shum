import { type ComponentChildren, createContext } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useRealtime } from '../lib/realtime.ts';
import { useSession } from '../state.tsx';
import { CallEngine, type CallViewState } from './engine.ts';
import { ring, unlockAudioOnFirstTouch } from './ringer.ts';

export interface CallsApi {
  state: CallViewState;
  start: (conversationId: string, video: boolean) => void;
  accept: () => void;
  decline: () => void;
  hangup: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  dismissMessage: () => void;
}

const CallsContext = createContext<CallsApi | null>(null);

export function useCalls(): CallsApi {
  const value = useContext(CallsContext);
  if (!value) throw new Error('useCalls() outside of CallProvider');
  return value;
}

export function CallProvider(props: { children: ComponentChildren }) {
  const { session } = useSession();
  const myId = useRef(session.user.id);
  myId.current = session.user.id;
  const engine = useMemo(() => new CallEngine(() => myId.current, { ring }), []);
  const [state, setState] = useState<CallViewState>(engine.getState());

  useEffect(() => {
    unlockAudioOnFirstTouch();
    const unsubscribe = engine.subscribe(() => setState(engine.getState()));
    const onLeave = () => engine.leaveQuietly();
    window.addEventListener('pagehide', onLeave);
    void engine.resume();
    return () => {
      window.removeEventListener('pagehide', onLeave);
      unsubscribe();
      engine.dispose();
    };
  }, [engine]);

  useRealtime((event) => engine.handle(event));

  const api = useMemo<CallsApi>(
    () => ({
      state,
      start: (conversationId, video) => void engine.start(conversationId, video),
      accept: () => void engine.accept(),
      decline: () => void engine.decline(),
      hangup: () => void engine.hangup(),
      toggleMute: () => engine.toggleMute(),
      toggleCamera: () => engine.toggleCamera(),
      dismissMessage: () => engine.clearMessage(),
    }),
    [state, engine],
  );
  return <CallsContext.Provider value={api}>{props.children}</CallsContext.Provider>;
}
