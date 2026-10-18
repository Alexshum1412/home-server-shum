import { type ComponentChildren, createContext } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatListResponse, NotificationsResponse, RealtimeEvent } from '../../../shared/api.ts';
import { type ApiFailure, apiGet, isAbortError, toFailure } from '../api.ts';
import { useRealtime, useRealtimeConnection } from '../lib/realtime.ts';
import { setUnreadInTitle } from '../lib/title.ts';

/**
 * What every page needs to know about the chat and the notifications: the list of conversations
 * with their unread counters (menu badge, tab title) and the notification list. Kept up to date by
 * live events; it also reloads when the window becomes visible again and when the connection returns.
 */
export interface ChatContextValue {
  list: ChatListResponse | null;
  error: ApiFailure | null;
  loading: boolean;
  reload: () => void;
  unread: number;
  notifications: NotificationsResponse | null;
  reloadNotifications: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const value = useContext(ChatContext);
  if (!value) throw new Error('useChat() outside of ChatProvider');
  return value;
}

/** Exported for tests, which provide a fixed list. */
export const ChatContextProvider = ChatContext.Provider;

const SAFETY_RELOAD_MS = 120_000;

export function ChatProvider(props: { children: ComponentChildren }) {
  useRealtimeConnection();
  const [list, setList] = useState<ChatListResponse | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] = useState<NotificationsResponse | null>(null);
  const listAbort = useRef<AbortController | null>(null);
  const notifyAbort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    try {
      const data = await apiGet<ChatListResponse>('/api/chat/conversations', { signal: controller.signal });
      if (controller.signal.aborted) return;
      setList(data);
      setError(null);
    } catch (failure) {
      if (controller.signal.aborted || isAbortError(failure)) return;
      setError(toFailure(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const loadNotifications = useCallback(async () => {
    notifyAbort.current?.abort();
    const controller = new AbortController();
    notifyAbort.current = controller;
    try {
      const data = await apiGet<NotificationsResponse>('/api/notifications', { signal: controller.signal });
      if (!controller.signal.aborted) setNotifications(data);
    } catch {
      // the badge simply keeps its last value
    }
  }, []);

  /** Several events in a row (a burst of messages) cause one reload. */
  const reloadSoon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 250);
  }, [load]);

  useEffect(() => {
    void load();
    void loadNotifications();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void load();
        void loadNotifications();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    const interval = setInterval(onVisible, SAFETY_RELOAD_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
      clearTimeout(timer.current);
      listAbort.current?.abort();
      notifyAbort.current?.abort();
    };
  }, [load, loadNotifications]);

  useRealtime((event: RealtimeEvent) => {
    if (event.type === 'hello') {
      void load();
      void loadNotifications();
    } else if (event.type === 'message' || event.type === 'conversation') {
      reloadSoon();
    } else if (event.type === 'read') {
      if (event.userId === list?.me.id) {
        // My own reading changes my unread counters: ask the server.
        reloadSoon();
      } else {
        // Somebody else read up to here: only the «прочитано» marks change.
        setList((current) =>
          current
            ? {
                ...current,
                conversations: current.conversations.map((conversation) =>
                  conversation.id === event.conversationId
                    ? { ...conversation, reads: { ...conversation.reads, [event.userId]: event.seq } }
                    : conversation,
                ),
              }
            : current,
        );
      }
    } else if (event.type === 'notification') {
      void loadNotifications();
    }
  });

  const unread = useMemo(
    () => list?.conversations.reduce((sum, conversation) => sum + conversation.unread, 0) ?? 0,
    [list],
  );
  useEffect(() => setUnreadInTitle(unread), [unread]);

  const value = useMemo<ChatContextValue>(
    () => ({
      list,
      error,
      loading,
      reload: () => void load(),
      unread,
      notifications,
      reloadNotifications: () => void loadNotifications(),
    }),
    [list, error, loading, load, unread, notifications, loadNotifications],
  );
  return <ChatContext.Provider value={value}>{props.children}</ChatContext.Provider>;
}
