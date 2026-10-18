import { MessageCirclePlus, MessagesSquare, Wifi, WifiOff } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { Avatar } from '../chat/Avatar.tsx';
import { useChat } from '../chat/ChatProvider.tsx';
import { NewChatDialog } from '../chat/Dialogs.tsx';
import { listTime } from '../chat/format.ts';
import { Thread } from '../chat/Thread.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { readParam, withQuery } from '../lib/query.ts';
import { useRealtimeStatus } from '../lib/realtime.ts';
import { navigate, useLocation } from '../router.ts';

export function ChatPage() {
  const { list, error, loading, reload } = useChat();
  const { search } = useLocation();
  const live = useRealtimeStatus();
  const selectedId = readParam(search, 'c');
  const [creating, setCreating] = useState(false);
  const selected = list?.conversations.find((conversation) => conversation.id === selectedId) ?? null;

  // On a wide screen the family room opens by itself, so the page is never an empty frame.
  useEffect(() => {
    if (!list || selectedId !== '') return;
    if (typeof matchMedia === 'function' && matchMedia('(min-width: 56rem)').matches) {
      const first = list.conversations[0];
      if (first) navigate(withQuery('/chat', { c: first.id }), { replace: true });
    }
  }, [list, selectedId]);

  const open = (id: string) => navigate(withQuery('/chat', { c: id }));

  return (
    <>
      <PageHeader
        title="Чат"
        icon={MessagesSquare}
        lead="Сообщения, фото и звонки для своих. Переписку видят только её участники — даже администратор сервера."
      />
      {loading && !list ? <Loading label="Загружаем чаты…" /> : null}
      {!list && error ? <ErrorState failure={error} onRetry={reload} /> : null}
      {list ? (
        <div class={selected ? 'chat chat--thread' : 'chat'}>
          <aside class="chat__side" aria-label="Список чатов">
            <div class="chat__side-head">
              <button type="button" class="button button--primary" onClick={() => setCreating(true)}>
                <MessageCirclePlus size={20} aria-hidden="true" />
                Новый чат
              </button>
              <p class={live === 'live' ? 'chat__live' : 'chat__live chat__live--off'} role="status">
                {live === 'live' ? (
                  <>
                    <Wifi size={16} aria-hidden="true" /> На связи
                  </>
                ) : (
                  <>
                    <WifiOff size={16} aria-hidden="true" /> Связь с сервером пропала — обновляем по таймеру
                  </>
                )}
              </p>
            </div>
            <ul class="convs">
              {list.conversations.map((conversation) => {
                const other =
                  conversation.kind === 'direct'
                    ? conversation.members.find((m) => m.id !== list.me.id)
                    : undefined;
                return (
                  <li key={conversation.id}>
                    <a
                      class="conv"
                      href={withQuery('/chat', { c: conversation.id })}
                      aria-current={conversation.id === selectedId ? 'page' : undefined}
                    >
                      <Avatar
                        id={other?.id ?? conversation.id}
                        name={conversation.title}
                        group={conversation.kind !== 'direct'}
                      />
                      <span class="conv__body">
                        <span class="conv__row">
                          <span class="conv__title">{conversation.title}</span>
                          {conversation.last ? (
                            <time class="conv__time">{listTime(conversation.last.at)}</time>
                          ) : null}
                        </span>
                        <span class="conv__row">
                          <span class="conv__preview">
                            {conversation.last
                              ? `${conversation.kind !== 'direct' && conversation.last.senderName ? `${conversation.last.senderName}: ` : ''}${conversation.last.preview}`
                              : 'Нет сообщений'}
                          </span>
                          {conversation.unread > 0 ? (
                            <span class="conv__badge">
                              {conversation.unread > 99 ? '99+' : conversation.unread}
                              <span class="visually-hidden"> непрочитанных</span>
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </aside>
          <div class="chat__main">
            {selected ? (
              <Thread
                key={selected.id}
                conversation={selected}
                me={list.me}
                people={list.people}
                maxAttachmentBytes={list.maxAttachmentBytes}
                onBack={() => navigate('/chat')}
                onListChanged={reload}
                onLeft={() => navigate('/chat', { replace: true })}
              />
            ) : selectedId !== '' ? (
              <EmptyState icon={MessagesSquare} title="Такого чата нет">
                Возможно, вас убрали из группы или чат удалён.
              </EmptyState>
            ) : (
              <EmptyState icon={MessagesSquare} title="Выберите чат">
                Слева — «Вся семья» и ваши личные чаты. Нажмите «Новый чат», чтобы написать кому-то одному или
                создать группу.
              </EmptyState>
            )}
          </div>
        </div>
      ) : null}
      {creating && list ? (
        <NewChatDialog
          people={list.people}
          onOpened={(conversation) => {
            reload();
            open(conversation.id);
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}
