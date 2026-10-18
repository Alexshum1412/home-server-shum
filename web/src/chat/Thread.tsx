import {
  ArrowDown,
  ArrowLeft,
  Download,
  FileText,
  Paperclip,
  Phone,
  RotateCw,
  SendHorizontal,
  Trash2,
  Users,
  Video,
} from 'lucide-preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChatConversation, ChatMessage, ChatMessagesResponse, ChatPerson } from '../../../shared/api.ts';
import { type ApiFailure, apiGet, apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { useCalls } from '../calls/CallProvider.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { formatBytes } from '../lib/format.ts';
import { useRealtime } from '../lib/realtime.ts';
import { putRaw } from '../lib/upload.ts';
import { Avatar } from './Avatar.tsx';
import { GroupDialog } from './Dialogs.tsx';
import { dayLabel, formatClock, sameDay, splitLinks } from './format.ts';

const PAGE = 40;
const NEAR_BOTTOM_PX = 140;

interface Pending {
  clientId: string;
  text: string;
  file: File | null;
  progress: number | null;
  failed: string | null;
  at: string;
}

function newClientId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function explain(error: unknown): string {
  const failure = toFailure(error);
  return failure.unreachable ? `${NO_CONNECTION}. Сообщение не отправлено.` : failure.message;
}

function Text(props: { text: string }) {
  return (
    <>
      {splitLinks(props.text).map((part, index) =>
        part.kind === 'link' ? (
          <a
            key={index}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            class="text-link"
          >
            {part.text}
          </a>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function AttachmentView(props: { message: ChatMessage }) {
  const { message } = props;
  const [broken, setBroken] = useState(false);
  const attachment = message.attachment;
  if (!attachment) return null;
  const url = `/api/chat/conversations/${message.conversationId}/messages/${message.id}/file`;
  const inline = `${url}?inline=1`;
  if (!broken && attachment.kind === 'image') {
    return (
      <a class="msg__media" href={inline} target="_blank" rel="noopener noreferrer">
        <img
          class="msg__image"
          src={inline}
          alt={`Фото «${attachment.name}»`}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      </a>
    );
  }
  if (!broken && attachment.kind === 'video') {
    return (
      // biome-ignore lint/a11y/useMediaCaption: a family video message has no captions
      <video
        class="msg__video"
        src={inline}
        controls
        preload="metadata"
        playsInline
        onError={() => setBroken(true)}
      />
    );
  }
  if (!broken && attachment.kind === 'audio') {
    return (
      // biome-ignore lint/a11y/useMediaCaption: a family audio message has no captions
      <audio class="msg__audio" src={inline} controls preload="none" onError={() => setBroken(true)} />
    );
  }
  return (
    <a class="msg__file" href={url} download={attachment.name}>
      <FileText size={22} aria-hidden="true" />
      <span class="msg__file-name">{attachment.name}</span>
      <span class="msg__file-size">{formatBytes(attachment.sizeBytes)}</span>
      <Download size={18} aria-hidden="true" />
      <span class="visually-hidden">Скачать</span>
    </a>
  );
}

export function Thread(props: {
  conversation: ChatConversation;
  me: ChatPerson;
  people: ChatPerson[];
  maxAttachmentBytes: number;
  onBack: () => void;
  onListChanged: () => void;
  onLeft: () => void;
}) {
  const { conversation, me } = props;
  const calls = useCalls();
  const id = conversation.id;
  const base = `/api/chat/conversations/${id}`;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [more, setMore] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [text, setText] = useState('');
  const [unseen, setUnseen] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showGroup, setShowGroup] = useState(false);
  const [notice, setNotice] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const readSent = useRef(0);
  const touchOnly = useRef(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);

  /** Puts messages in order, once each; a changed message (deleted) replaces the old one. */
  const merge = useCallback((incoming: ChatMessage[]) => {
    setMessages((current) => {
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of incoming) byId.set(message.id, message);
      return [...byId.values()].sort((a, b) => a.seq - b.seq);
    });
    const done = new Set(
      incoming.map((message) => message.clientId).filter((value): value is string => !!value),
    );
    if (done.size > 0) setPending((current) => current.filter((item) => !done.has(item.clientId)));
  }, []);

  const messagesCountRef = useRef(0);
  messagesCountRef.current = messages.length;

  const load = useCallback(async () => {
    try {
      const data = await apiGet<ChatMessagesResponse>(`${base}/messages?limit=${PAGE}`);
      merge(data.messages);
      setMore((previous) => (messagesCountRef.current === 0 ? data.more : previous || data.more));
      setStatus('ready');
      setFailure(null);
    } catch (error) {
      setFailure(toFailure(error));
      setStatus((previous) => (previous === 'ready' ? 'ready' : 'error'));
    }
  }, [base, merge]);

  useEffect(() => {
    stick.current = true;
    readSent.current = 0;
    void load();
  }, [load]);

  useRealtime((event) => {
    if (event.type === 'message' && event.message.conversationId === id) {
      const mine = event.message.senderId === me.id;
      merge([event.message]);
      if (!stick.current && !mine) setUnseen((count) => count + 1);
    } else if (event.type === 'hello') {
      void load();
    }
  });

  // Keep the bottom in view while the person is at the bottom.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, pending.length, status]);

  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (stick.current && unseen > 0) setUnseen(0);
  }

  function jumpDown() {
    const element = scroller.current;
    stick.current = true;
    setUnseen(0);
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }

  // Tell the server how far this person has read, while the window is in front.
  const lastSeq = messages[messages.length - 1]?.seq ?? 0;
  const myRead = conversation.reads[me.id] ?? 0;
  useEffect(() => {
    if (lastSeq === 0 || lastSeq <= myRead || lastSeq <= readSent.current) return;
    const send = () => {
      if (document.visibilityState !== 'visible') return;
      readSent.current = lastSeq;
      apiPost(`${base}/read`, { seq: lastSeq }).catch(() => {
        readSent.current = 0;
      });
    };
    send();
    document.addEventListener('visibilitychange', send);
    return () => document.removeEventListener('visibilitychange', send);
  }, [lastSeq, myRead, base]);

  async function showOlder() {
    const first = messages[0];
    const element = scroller.current;
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    const heightBefore = element?.scrollHeight ?? 0;
    try {
      const data = await apiGet<ChatMessagesResponse>(`${base}/messages?limit=${PAGE}&before=${first.seq}`);
      stick.current = false;
      merge(data.messages);
      setMore(data.more);
      requestAnimationFrame(() => {
        if (element) element.scrollTop = element.scrollHeight - heightBefore;
      });
    } catch (error) {
      setNotice(explain(error));
    } finally {
      setLoadingOlder(false);
    }
  }

  const update = (clientId: string, patch: Partial<Pending>) =>
    setPending((current) =>
      current.map((item) => (item.clientId === clientId ? { ...item, ...patch } : item)),
    );

  async function deliver(item: Pending) {
    update(item.clientId, { failed: null, progress: item.file ? 0 : null });
    try {
      if (item.file) {
        const query = new URLSearchParams({
          name: item.file.name,
          size: String(item.file.size),
          text: item.text,
          clientId: item.clientId,
        });
        const body = await putRaw(`${base}/attachment?${query.toString()}`, item.file, (loaded, total) =>
          update(item.clientId, { progress: total > 0 ? loaded / total : null }),
        );
        stick.current = true;
        merge([JSON.parse(body) as ChatMessage]);
      } else {
        const sent = await apiPost<ChatMessage>(`${base}/messages`, {
          text: item.text,
          clientId: item.clientId,
        });
        stick.current = true;
        merge([sent]);
      }
      props.onListChanged();
    } catch (error) {
      update(item.clientId, { failed: explain(error), progress: null });
    }
  }

  function submit(event?: Event) {
    event?.preventDefault();
    const body = text.trim();
    if (body === '') return;
    setText('');
    const item: Pending = {
      clientId: newClientId(),
      text: body,
      file: null,
      progress: null,
      failed: null,
      at: new Date().toISOString(),
    };
    stick.current = true;
    setPending((current) => [...current, item]);
    void deliver(item);
    field.current?.focus();
  }

  function chooseFiles(list: FileList | null) {
    const chosen = Array.from(list ?? []);
    if (files.current) files.current.value = '';
    setNotice('');
    for (const [index, file] of chosen.entries()) {
      if (file.size > props.maxAttachmentBytes) {
        setNotice(
          `Файл «${file.name}» слишком большой: можно не больше ${formatBytes(props.maxAttachmentBytes)}.`,
        );
        continue;
      }
      if (file.size === 0) {
        setNotice(`Файл «${file.name}» пустой.`);
        continue;
      }
      const item: Pending = {
        clientId: newClientId(),
        // The typed text goes with the first file only.
        text: index === 0 ? text.trim() : '',
        file,
        progress: 0,
        failed: null,
        at: new Date().toISOString(),
      };
      if (index === 0) setText('');
      stick.current = true;
      setPending((current) => [...current, item]);
      void deliver(item);
    }
  }

  async function remove(message: ChatMessage) {
    if (!window.confirm('Удалить это сообщение у всех?')) return;
    try {
      await apiPost(`${base}/messages/${message.id}/delete`);
      props.onListChanged();
    } catch (error) {
      setNotice(explain(error));
    }
  }

  function onKey(event: KeyboardEvent) {
    // On a phone Enter is a new line (the arrow sends); on a computer Enter sends, Shift+Enter is a new line.
    if (event.key === 'Enter' && !event.shiftKey && !touchOnly.current && !event.isComposing) submit(event);
  }

  function grow(element: HTMLTextAreaElement) {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }

  const isDirect = conversation.kind === 'direct';
  const memberLine = isDirect
    ? ''
    : conversation.members.map((member) => (member.id === me.id ? 'вы' : member.displayName)).join(', ');
  const other = isDirect ? conversation.members.find((member) => member.id !== me.id) : undefined;
  const busyCall = calls.state.phase !== 'idle' && calls.state.phase !== 'ended';
  const lastMine = [...messages].reverse().find((message) => message.senderId === me.id && !message.deleted);
  const othersRead = Object.entries(conversation.reads).filter(([user]) => user !== me.id);

  function readLabel(message: ChatMessage): string {
    if (message.id !== lastMine?.id) return '';
    const readBy = othersRead.filter(([, seq]) => seq >= message.seq).length;
    const total = conversation.members.length - 1;
    if (isDirect) return readBy > 0 ? 'Прочитано' : 'Доставлено';
    return readBy > 0 ? `Прочитали: ${readBy} из ${total}` : 'Доставлено';
  }

  return (
    <section class="thread" aria-label={`Чат: ${conversation.title}`}>
      <header class="thread__head">
        <button type="button" class="button button--quiet thread__back" onClick={props.onBack}>
          <ArrowLeft size={20} aria-hidden="true" />
          <span class="visually-hidden">К списку чатов</span>
        </button>
        <Avatar id={other?.id ?? conversation.id} name={conversation.title} group={!isDirect} />
        <div class="thread__title">
          <h2 class="thread__name">{conversation.title}</h2>
          {memberLine ? <p class="thread__members">{memberLine}</p> : null}
        </div>
        <div class="thread__actions">
          <button
            type="button"
            class="button button--quiet"
            disabled={busyCall}
            onClick={() => calls.start(id, false)}
          >
            <Phone size={20} aria-hidden="true" />
            <span class="thread__action-text">Позвонить</span>
          </button>
          <button
            type="button"
            class="button button--quiet"
            disabled={busyCall}
            onClick={() => calls.start(id, true)}
          >
            <Video size={20} aria-hidden="true" />
            <span class="thread__action-text">Видео</span>
          </button>
          {!isDirect ? (
            <button type="button" class="button button--quiet" onClick={() => setShowGroup(true)}>
              <Users size={20} aria-hidden="true" />
              <span class="thread__action-text">
                {conversation.kind === 'group' ? 'Группа' : 'Участники'}
              </span>
            </button>
          ) : null}
        </div>
      </header>

      <div class="thread__scroll" ref={scroller} onScroll={onScroll}>
        {status === 'loading' ? <Loading label="Загружаем сообщения…" /> : null}
        {status === 'error' && failure ? <ErrorState failure={failure} onRetry={() => void load()} /> : null}
        {status === 'ready' ? (
          <>
            {more ? (
              <button
                type="button"
                class="button button--secondary thread__older"
                disabled={loadingOlder}
                onClick={() => void showOlder()}
              >
                {loadingOlder ? 'Загружаем…' : 'Показать более ранние'}
              </button>
            ) : null}
            <ol class="msgs" aria-label="Сообщения">
              {messages.map((message, index) => {
                const previous = messages[index - 1];
                const newDay = !previous || !sameDay(previous.at, message.at);
                const mine = message.senderId === me.id;
                const groupedWithPrevious =
                  !!previous &&
                  !newDay &&
                  previous.senderId === message.senderId &&
                  previous.system === null &&
                  message.system === null;
                return (
                  <li key={message.id} class="msgs__item">
                    {newDay ? <p class="msg-day">{dayLabel(message.at)}</p> : null}
                    {message.system ? (
                      <p class="msg msg--system">{message.text}</p>
                    ) : (
                      <div
                        class={`msg${mine ? ' msg--mine' : ''}${groupedWithPrevious ? ' msg--grouped' : ''}`}
                      >
                        {!mine && !isDirect && !groupedWithPrevious ? (
                          <p class="msg__author">{message.senderName}</p>
                        ) : null}
                        <div class="msg__bubble">
                          {message.deleted ? (
                            <p class="msg__deleted">Сообщение удалено</p>
                          ) : (
                            <>
                              <AttachmentView message={message} />
                              {message.text ? (
                                <p class="msg__text">
                                  <Text text={message.text} />
                                </p>
                              ) : null}
                            </>
                          )}
                          <p class="msg__meta">
                            <time dateTime={message.at}>{formatClock(message.at)}</time>
                            {mine && !message.deleted ? <span>{readLabel(message)}</span> : null}
                            {mine && !message.deleted ? (
                              <button type="button" class="msg__delete" onClick={() => void remove(message)}>
                                <Trash2 size={14} aria-hidden="true" />
                                <span class="visually-hidden">Удалить сообщение</span>
                              </button>
                            ) : null}
                          </p>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
              {pending.map((item) => (
                <li key={item.clientId} class="msgs__item">
                  <div class="msg msg--mine msg--pending">
                    <div class="msg__bubble">
                      {item.file ? (
                        <p class="msg__file msg__file--pending">
                          <Paperclip size={20} aria-hidden="true" />
                          <span class="msg__file-name">{item.file.name}</span>
                          <span class="msg__file-size">{formatBytes(item.file.size)}</span>
                        </p>
                      ) : null}
                      {item.text ? <p class="msg__text">{item.text}</p> : null}
                      {item.progress !== null && !item.failed ? (
                        <progress
                          class="msg__progress"
                          max={100}
                          value={Math.round(item.progress * 100)}
                          aria-label={`Отправка «${item.file?.name ?? 'сообщения'}»: ${Math.round(item.progress * 100)} %`}
                        />
                      ) : null}
                      <p class="msg__meta">
                        {item.failed ? (
                          <>
                            <span class="msg__failed" role="alert">
                              {item.failed}
                            </span>
                            <button
                              type="button"
                              class="button button--quiet msg__retry"
                              onClick={() => void deliver(item)}
                            >
                              <RotateCw size={16} aria-hidden="true" />
                              Повторить
                            </button>
                            <button
                              type="button"
                              class="button button--quiet msg__retry"
                              onClick={() =>
                                setPending((current) => current.filter((p) => p.clientId !== item.clientId))
                              }
                            >
                              Убрать
                            </button>
                          </>
                        ) : (
                          <span>Отправляется…</span>
                        )}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            {messages.length === 0 && pending.length === 0 ? (
              <p class="thread__empty">Здесь пока нет сообщений. Напишите первое.</p>
            ) : null}
          </>
        ) : null}
      </div>

      {unseen > 0 ? (
        <button type="button" class="button button--primary thread__jump" onClick={jumpDown}>
          <ArrowDown size={18} aria-hidden="true" />
          Новые сообщения: {unseen}
        </button>
      ) : null}

      {notice ? (
        <p class="thread__notice" role="alert">
          {notice}
        </p>
      ) : null}
      <form class="composer" onSubmit={submit}>
        <label class="button button--quiet composer__attach" htmlFor={`${id}-file`}>
          <Paperclip size={22} aria-hidden="true" />
          <span class="visually-hidden">Прикрепить фото или файл</span>
        </label>
        <input
          ref={files}
          class="visually-hidden"
          type="file"
          multiple
          id={`${id}-file`}
          tabIndex={-1}
          onChange={(e) => chooseFiles(e.currentTarget.files)}
        />
        <textarea
          ref={field}
          class="field__input composer__input"
          rows={1}
          maxLength={4000}
          placeholder="Сообщение"
          aria-label="Сообщение"
          value={text}
          onInput={(e) => {
            setText(e.currentTarget.value);
            grow(e.currentTarget);
          }}
          onKeyDown={onKey}
        />
        <button type="submit" class="button button--primary composer__send" disabled={text.trim() === ''}>
          <SendHorizontal size={22} aria-hidden="true" />
          <span class="visually-hidden">Отправить</span>
        </button>
      </form>
      {showGroup ? (
        <GroupDialog
          conversation={conversation}
          people={props.people}
          me={me}
          onChanged={props.onListChanged}
          onLeft={props.onLeft}
          onClose={() => setShowGroup(false)}
        />
      ) : null}
    </section>
  );
}
