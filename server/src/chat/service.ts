/**
 * Rules of the family chat on top of the store: who may see and do what.
 *
 * - Everyone signed in belongs to the one «Вся семья» room.
 * - A direct chat has exactly two people; a group has the people its owner added.
 * - Nobody else — an administrator included — can open a conversation they are not in: for them it
 *   does not exist (404, not 403).
 * - Only the sender deletes a message; an attachment goes to the chat's trash folder, not to oblivion.
 */
import { createWriteStream, promises as fsp, type Stats } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import type {
  ChatAttachmentKind,
  ChatConversation,
  ChatListResponse,
  ChatMessage,
  ChatMessagesResponse,
  ChatPerson,
} from '../../../shared/api.ts';
import { isDisabled, type StoredUser, type UserStore } from '../auth/users.ts';
import { BLOCKED_TYPE_MESSAGE, isBlockedName, sanitizeName } from '../files/names.ts';
import { looksLikeProgram, sniffMedia, writeFromRequest } from '../files/storage.ts';
import { newId } from '../lib/ids.ts';
import type { NotificationCenter } from '../notify/center.ts';
import type { RealtimeHub } from '../realtime/hub.ts';
import {
  type ChatStore,
  type ConversationRec,
  FAMILY_ID,
  isConversationId,
  type MessageRec,
} from './store.ts';

export const MESSAGE_MAX = 4000;
export const GROUP_TITLE_MAX = 60;
export const GROUP_MEMBERS_MAX = 12;
export const GROUPS_PER_PERSON_MAX = 30;
export const PAGE_MAX = 100;

export class ChatError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const NOT_FOUND = () => new ChatError(404, 'not_found', 'Такого чата нет.');
const FORMER = 'Бывший участник';
const SERVER_NAME = 'Семейный сервер';

const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
};

/** What a stored attachment is, by its content first and its name second. */
export function classifyAttachment(name: string, head: Buffer): { kind: ChatAttachmentKind; mime: string } {
  const sniffed = sniffMedia(head);
  if (sniffed) return sniffed;
  const audio = AUDIO_TYPES[path.extname(name).toLowerCase()];
  if (audio) return { kind: 'audio', mime: audio };
  return { kind: 'file', mime: 'application/octet-stream' };
}

export interface ChatServiceOptions {
  store: ChatStore;
  users: UserStore;
  hub: RealtimeHub;
  notify: NotificationCenter;
  /** Folder of the chat (attachments are below it). */
  dir: string;
  maxAttachmentBytes: number;
  minFreeBytes: number;
  freeBytes: (dir: string) => Promise<number | null>;
}

export interface ChatService {
  start(): Promise<void>;
  list(me: StoredUser): Promise<ChatListResponse>;
  openDirect(me: StoredUser, otherId: string): Promise<ChatConversation>;
  createGroup(me: StoredUser, title: string, memberIds: readonly string[]): Promise<ChatConversation>;
  rename(me: StoredUser, id: string, title: string): Promise<ChatConversation>;
  addMembers(me: StoredUser, id: string, memberIds: readonly string[]): Promise<ChatConversation>;
  removeMember(me: StoredUser, id: string, memberId: string): Promise<ChatConversation>;
  leave(me: StoredUser, id: string): Promise<void>;
  messages(me: StoredUser, id: string, before: number | null, limit: number): Promise<ChatMessagesResponse>;
  send(me: StoredUser, id: string, text: string, clientId: string | null): Promise<ChatMessage>;
  sendAttachment(
    me: StoredUser,
    id: string,
    input: { name: string; size: number; text: string; clientId: string | null },
    body: NodeJS.ReadableStream,
  ): Promise<ChatMessage>;
  markRead(me: StoredUser, id: string, seq: number): Promise<void>;
  deleteMessage(me: StoredUser, id: string, messageId: string): Promise<void>;
  openAttachment(
    me: StoredUser,
    id: string,
    messageId: string,
  ): Promise<{ file: string; stat: Stats; name: string; mime: string; kind: ChatAttachmentKind }>;
  /** Server-made line in a chat (calls). */
  addSystem(conversationId: string, text: string, kind: 'call' | 'call-missed', to?: string[]): Promise<void>;
  /** Everyone who may read the conversation, or null when it does not exist. */
  audience(
    conversationId: string,
  ): Promise<{ title: string; ids: string[]; kind: ConversationRec['kind'] } | null>;
  onUserRemoved(userId: string): Promise<void>;
}

export function createChatService(options: ChatServiceOptions): ChatService {
  const { store, users, hub, notify } = options;
  let reserved = 0;

  async function directory(): Promise<Map<string, StoredUser>> {
    return new Map((await users.list()).map((user) => [user.id, user]));
  }

  const nameIn = (dir: Map<string, StoredUser>, id: string | null): string =>
    id === null ? SERVER_NAME : (dir.get(id)?.displayName ?? FORMER);

  function memberIds(rec: ConversationRec, dir: Map<string, StoredUser>): string[] {
    return rec.kind === 'family' ? [...dir.keys()] : rec.members;
  }

  function isMember(rec: ConversationRec, userId: string): boolean {
    return rec.kind === 'family' || rec.members.includes(userId);
  }

  function requireConversation(me: StoredUser, id: string): ConversationRec {
    if (!isConversationId(id)) throw NOT_FOUND();
    const rec = store.conversation(id);
    if (!rec || !isMember(rec, me.id)) throw NOT_FOUND();
    return rec;
  }

  function previewOf(message: MessageRec): string {
    if (message.deletedAt) return 'Сообщение удалено';
    if (message.text !== '') return message.text.replace(/\s+/g, ' ').slice(0, 80);
    if (message.att) {
      const label = { image: 'Фото', video: 'Видео', audio: 'Аудио', file: `Файл: ${message.att.name}` }[
        message.att.kind
      ];
      return label.slice(0, 80);
    }
    return '';
  }

  function messageView(
    message: MessageRec,
    conversationId: string,
    dir: Map<string, StoredUser>,
    me?: string,
  ): ChatMessage {
    return {
      id: message.id,
      conversationId,
      seq: message.seq,
      at: message.at,
      senderId: message.sender,
      senderName: nameIn(dir, message.sender),
      text: message.deletedAt ? '' : message.text,
      attachment: message.att
        ? {
            name: message.att.name,
            sizeBytes: message.att.size,
            mime: message.att.mime,
            kind: message.att.kind,
          }
        : null,
      deleted: message.deletedAt !== null,
      system: message.sys,
      clientId: me !== undefined && message.sender === me ? message.cid : null,
    };
  }

  function titleFor(rec: ConversationRec, me: StoredUser, dir: Map<string, StoredUser>): string {
    if (rec.kind === 'family') return 'Вся семья';
    if (rec.kind === 'group') return rec.title ?? 'Группа';
    const other = rec.members.find((id) => id !== me.id);
    return other ? nameIn(dir, other) : FORMER;
  }

  async function viewOf(
    rec: ConversationRec,
    me: StoredUser,
    dir: Map<string, StoredUser>,
  ): Promise<ChatConversation> {
    const messages = await store.messages(rec.id);
    const read = store.readOf(rec.id);
    const mine = read[me.id] ?? 0;
    let unread = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as MessageRec;
      if (message.seq <= mine) break;
      if (
        message.sender !== me.id &&
        !message.deletedAt &&
        (message.sender !== null || message.sys === 'call-missed') &&
        (message.to === null || message.to.includes(me.id))
      ) {
        unread += 1;
      }
    }
    const last = [...messages].reverse().find((message) => message.sys !== 'created');
    return {
      id: rec.id,
      kind: rec.kind,
      title: titleFor(rec, me, dir),
      members: memberIds(rec, dir).map((id) => ({ id, displayName: nameIn(dir, id) })),
      ownerId: rec.ownerId,
      unread,
      updatedAt: rec.updatedAt,
      last: last ? { at: last.at, preview: previewOf(last), senderName: nameIn(dir, last.sender) } : null,
      reads: read,
      canManage: rec.kind === 'group' && rec.ownerId === me.id,
    };
  }

  function announce(rec: ConversationRec, dir: Map<string, StoredUser>, extra: readonly string[] = []): void {
    for (const id of new Set([...memberIds(rec, dir), ...extra])) {
      hub.publish([id], { type: 'conversation', conversationId: rec.id });
    }
  }

  async function postSystem(
    rec: ConversationRec,
    text: string,
    kind: MessageRec['sys'],
    to?: string[],
  ): Promise<void> {
    const message = await store.append(rec.id, { sender: null, text, sys: kind, ...(to ? { to } : {}) });
    const dir = await directory();
    const view = messageView(message, rec.id, dir);
    hub.publish(memberIds(rec, dir), { type: 'message', message: view });
  }

  async function deliver(
    rec: ConversationRec,
    message: MessageRec,
    sender: StoredUser,
  ): Promise<ChatMessage> {
    const dir = await directory();
    const targets = memberIds(rec, dir);
    const view = messageView(message, rec.id, dir);
    for (const id of targets) {
      hub.publish([id], {
        type: 'message',
        message: { ...view, clientId: id === sender.id ? message.cid : null },
      });
    }
    const where =
      rec.kind === 'direct' ? sender.displayName : `${sender.displayName} · ${titleFor(rec, sender, dir)}`;
    void notify
      .notify({
        users: targets.filter((id) => id !== sender.id),
        kind: 'message',
        title: where,
        body: 'Новое сообщение',
        previewBody: previewOf(message),
        url: `/chat?c=${rec.id}`,
        feed: false,
        topic: `chat-${rec.id.slice(0, 8)}`,
      })
      .catch(() => undefined);
    return { ...view, clientId: message.cid };
  }

  /** Line breaks are kept; the other control characters (they only confuse screens and logs) are dropped. */
  function cleanText(text: string): string {
    let clean = '';
    for (const char of text.replace(/\r\n?/g, '\n')) {
      const code = char.codePointAt(0) ?? 0;
      if (code === 10 || code === 9 || (code >= 32 && code !== 127)) clean += char;
    }
    return clean.trim();
  }

  async function validPeople(ids: readonly string[], dir: Map<string, StoredUser>): Promise<string[]> {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      if (!dir.has(id)) throw new ChatError(400, 'bad_member', 'Такого человека в семье нет.');
    }
    return unique;
  }

  async function ensureSpace(dir: string, bytes: number): Promise<void> {
    const free = await options.freeBytes(dir);
    if (free !== null && free - reserved - bytes < options.minFreeBytes) {
      throw new ChatError(507, 'no_space', 'На диске сервера мало места. Сообщите администратору.');
    }
  }

  const service: ChatService = {
    async start() {
      await store.load();
      if (!store.conversation(FAMILY_ID)) {
        store.create({ id: FAMILY_ID, kind: 'family', title: 'Вся семья', members: [], ownerId: null });
        await postSystem(
          store.conversation(FAMILY_ID) as ConversationRec,
          'Общий чат семьи создан.',
          'created',
        );
      }
    },

    async list(me) {
      const dir = await directory();
      const visible = store.conversations().filter((rec) => isMember(rec, me.id));
      const views = await Promise.all(visible.map((rec) => viewOf(rec, me, dir)));
      views.sort((a, b) => Date.parse(b.last?.at ?? b.updatedAt) - Date.parse(a.last?.at ?? a.updatedAt));
      const people: ChatPerson[] = [...dir.values()]
        .filter((user) => user.id !== me.id && !isDisabled(user))
        .map((user) => ({ id: user.id, displayName: user.displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
      return {
        me: { id: me.id, displayName: me.displayName },
        conversations: views,
        people,
        maxAttachmentBytes: options.maxAttachmentBytes,
      };
    },

    async openDirect(me, otherId) {
      const dir = await directory();
      const other = dir.get(otherId);
      if (otherId === me.id || !other || isDisabled(other)) {
        throw new ChatError(400, 'bad_member', 'Выберите другого человека из семьи.');
      }
      let rec = store
        .conversations()
        .find(
          (item) =>
            item.kind === 'direct' &&
            item.members.length === 2 &&
            item.members.includes(me.id) &&
            item.members.includes(otherId),
        );
      if (!rec) {
        rec = store.create({ kind: 'direct', title: null, members: [me.id, otherId], ownerId: null });
        announce(rec, dir);
      }
      return viewOf(rec, me, dir);
    },

    async createGroup(me, title, ids) {
      const name = cleanText(title).slice(0, GROUP_TITLE_MAX);
      if (name === '') throw new ChatError(400, 'bad_title', 'Назовите группу.');
      const dir = await directory();
      const others = (await validPeople(ids, dir)).filter((id) => id !== me.id);
      if (others.length === 0)
        throw new ChatError(400, 'bad_member', 'Добавьте в группу хотя бы одного человека.');
      if (others.length + 1 > GROUP_MEMBERS_MAX) {
        throw new ChatError(400, 'too_many', `В группе может быть не больше ${GROUP_MEMBERS_MAX} человек.`);
      }
      const owned = store
        .conversations()
        .filter((item) => item.kind === 'group' && item.ownerId === me.id).length;
      if (owned >= GROUPS_PER_PERSON_MAX) {
        throw new ChatError(409, 'too_many_groups', 'Слишком много групп. Удалите ненужные: выйдите из них.');
      }
      const rec = store.create({ kind: 'group', title: name, members: [me.id, ...others], ownerId: me.id });
      await postSystem(rec, `Группа «${name}» создана.`, 'created');
      announce(rec, dir);
      return viewOf(rec, me, dir);
    },

    async rename(me, id, title) {
      const rec = requireConversation(me, id);
      if (rec.kind !== 'group') throw new ChatError(400, 'not_group', 'Переименовать можно только группу.');
      if (rec.ownerId !== me.id)
        throw new ChatError(403, 'forbidden', 'Группу переименовывает тот, кто её создал.');
      const name = cleanText(title).slice(0, GROUP_TITLE_MAX);
      if (name === '') throw new ChatError(400, 'bad_title', 'Назовите группу.');
      store.update(id, { title: name });
      const dir = await directory();
      announce(rec, dir);
      return viewOf(rec, me, dir);
    },

    async addMembers(me, id, ids) {
      const rec = requireConversation(me, id);
      if (rec.kind !== 'group')
        throw new ChatError(400, 'not_group', 'Людей можно добавлять только в группу.');
      if (rec.ownerId !== me.id)
        throw new ChatError(403, 'forbidden', 'Людей добавляет тот, кто создал группу.');
      const dir = await directory();
      const fresh = (await validPeople(ids, dir)).filter((member) => !rec.members.includes(member));
      if (fresh.length === 0) throw new ChatError(400, 'bad_member', 'Эти люди уже в группе.');
      if (rec.members.length + fresh.length > GROUP_MEMBERS_MAX) {
        throw new ChatError(400, 'too_many', `В группе может быть не больше ${GROUP_MEMBERS_MAX} человек.`);
      }
      store.update(id, { members: [...rec.members, ...fresh] });
      await postSystem(
        rec,
        `В группу добавлены: ${fresh.map((member) => nameIn(dir, member)).join(', ')}.`,
        'member-added',
      );
      announce(rec, dir);
      return viewOf(rec, me, dir);
    },

    async removeMember(me, id, memberId) {
      const rec = requireConversation(me, id);
      if (rec.kind !== 'group')
        throw new ChatError(400, 'not_group', 'Убирать людей можно только из группы.');
      if (rec.ownerId !== me.id)
        throw new ChatError(403, 'forbidden', 'Людей убирает тот, кто создал группу.');
      if (memberId === me.id)
        throw new ChatError(400, 'bad_member', 'Чтобы выйти из группы, нажмите «Выйти».');
      if (!rec.members.includes(memberId))
        throw new ChatError(404, 'not_found', 'Этого человека в группе нет.');
      const dir = await directory();
      store.update(id, { members: rec.members.filter((member) => member !== memberId) });
      await postSystem(rec, `Из группы удалён: ${nameIn(dir, memberId)}.`, 'member-removed');
      announce(rec, dir, [memberId]);
      return viewOf(rec, me, dir);
    },

    async leave(me, id) {
      const rec = requireConversation(me, id);
      if (rec.kind !== 'group') throw new ChatError(400, 'not_group', 'Из этого чата выйти нельзя.');
      const dir = await directory();
      const rest = rec.members.filter((member) => member !== me.id);
      // The group goes on under its oldest remaining member.
      store.update(id, { members: rest, ownerId: rec.ownerId === me.id ? (rest[0] ?? null) : rec.ownerId });
      if (rest.length > 0) await postSystem(rec, `Из группы вышел: ${me.displayName}.`, 'member-left');
      announce(rec, dir, [me.id]);
    },

    async messages(me, id, before, limit) {
      const rec = requireConversation(me, id);
      const dir = await directory();
      const all = await store.messages(rec.id);
      const end = before === null ? all.length : all.findIndex((message) => message.seq >= before);
      const stop = end === -1 ? all.length : end;
      const size = Math.min(Math.max(limit, 1), PAGE_MAX);
      const start = Math.max(0, stop - size);
      return {
        messages: all.slice(start, stop).map((message) => messageView(message, rec.id, dir, me.id)),
        more: start > 0,
      };
    },

    async send(me, id, text, clientId) {
      const rec = requireConversation(me, id);
      const body = cleanText(text);
      if (body === '') throw new ChatError(400, 'empty', 'Напишите сообщение.');
      if (body.length > MESSAGE_MAX) {
        throw new ChatError(413, 'too_long', `Сообщение слишком длинное: не больше ${MESSAGE_MAX} знаков.`);
      }
      if (clientId) {
        // The page repeated a request whose answer it never got: return the first one, send nothing new.
        const earlier = (await store.messages(rec.id))
          .slice(-200)
          .find((item) => item.sender === me.id && item.cid === clientId);
        if (earlier) return messageView(earlier, rec.id, await directory(), me.id);
      }
      const message = await store.append(rec.id, { sender: me.id, text: body, cid: clientId });
      return deliver(rec, message, me);
    },

    async sendAttachment(me, id, input, body) {
      const rec = requireConversation(me, id);
      const name = sanitizeName(input.name);
      if (!name || name.startsWith('.')) throw new ChatError(400, 'bad_name', 'Недопустимое имя файла.');
      if (isBlockedName(name)) throw new ChatError(422, 'blocked_type', BLOCKED_TYPE_MESSAGE);
      if (!Number.isFinite(input.size) || input.size <= 0) {
        throw new ChatError(411, 'length_required', 'Неизвестен размер файла.');
      }
      if (input.size > options.maxAttachmentBytes) {
        throw new ChatError(
          413,
          'too_large',
          `Файл слишком большой: не больше ${Math.round(options.maxAttachmentBytes / 1024 ** 2)} МБ.`,
        );
      }
      const text = cleanText(input.text).slice(0, MESSAGE_MAX);
      if (input.clientId) {
        const earlier = (await store.messages(rec.id))
          .slice(-200)
          .find((item) => item.sender === me.id && item.cid === input.clientId);
        if (earlier) {
          body.resume();
          return messageView(earlier, rec.id, await directory(), me.id);
        }
      }
      const folder = store.attachmentsDir(rec.id);
      await fsp.mkdir(folder, { recursive: true });
      await ensureSpace(folder, input.size);
      reserved += input.size;
      const messageId = newId();
      const temp = path.join(folder, `.upload-${messageId}`);
      let received = 0;
      let head = Buffer.alloc(0);
      let checked = false;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, callback) {
          received += chunk.length;
          if (received > input.size || received > options.maxAttachmentBytes) {
            callback(new ChatError(413, 'too_large', 'Файл больше заявленного размера.'));
            return;
          }
          if (!checked) {
            head = Buffer.concat([head, chunk]).subarray(0, 32);
            if (head.length >= 16 || received >= input.size) {
              checked = true;
              if (looksLikeProgram(head)) {
                callback(new ChatError(422, 'blocked_type', BLOCKED_TYPE_MESSAGE));
                return;
              }
            }
          }
          callback(null, chunk);
        },
      });
      try {
        await writeFromRequest(body, guard, createWriteStream(temp, { flags: 'wx' }));
        if (received !== input.size) {
          throw new ChatError(400, 'incomplete', 'Файл передан не полностью. Попробуйте ещё раз.');
        }
        const { kind, mime } = classifyAttachment(name, head);
        await fsp.rename(temp, store.attachmentPath(rec.id, messageId));
        const message = await store.append(rec.id, {
          id: messageId,
          sender: me.id,
          text,
          att: { name, size: received, mime, kind },
          cid: input.clientId,
        });
        return await deliver(rec, message, me);
      } catch (error) {
        await fsp.rm(temp, { force: true }).catch(() => undefined);
        if (error instanceof ChatError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOSPC') throw new ChatError(507, 'no_space', 'На диске сервера закончилось место.');
        if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
          throw new ChatError(400, 'incomplete', 'Передача файла прервалась. Попробуйте ещё раз.');
        }
        throw error;
      } finally {
        reserved -= input.size;
      }
    },

    async markRead(me, id, seq) {
      const rec = requireConversation(me, id);
      const all = await store.messages(rec.id);
      const top = all[all.length - 1]?.seq ?? 0;
      const value = Math.min(Math.max(0, Math.trunc(seq)), top);
      if (!store.setRead(rec.id, me.id, value)) return;
      const dir = await directory();
      hub.publish(memberIds(rec, dir), { type: 'read', conversationId: rec.id, userId: me.id, seq: value });
    },

    async deleteMessage(me, id, messageId) {
      const rec = requireConversation(me, id);
      const all = await store.messages(rec.id);
      const target = all.find((item) => item.id === messageId);
      if (!target) throw new ChatError(404, 'not_found', 'Такого сообщения нет.');
      if (target.sender !== me.id)
        throw new ChatError(403, 'forbidden', 'Удалить можно только своё сообщение.');
      const hadFile = target.att !== null;
      const removed = await store.markDeleted(rec.id, messageId);
      if (!removed) return;
      if (hadFile) {
        const bin = path.join(options.dir, '.trash');
        await fsp.mkdir(bin, { recursive: true });
        await fsp
          .rename(store.attachmentPath(rec.id, messageId), path.join(bin, `${rec.id}-${messageId}`))
          .catch(() => undefined);
      }
      const dir = await directory();
      const view = messageView(removed, rec.id, dir);
      hub.publish(memberIds(rec, dir), { type: 'message', message: view });
    },

    async openAttachment(me, id, messageId) {
      const rec = requireConversation(me, id);
      const message = (await store.messages(rec.id)).find((item) => item.id === messageId);
      if (!message?.att || message.deletedAt) throw new ChatError(404, 'not_found', 'Такого вложения нет.');
      const file = store.attachmentPath(rec.id, messageId);
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat?.isFile()) throw new ChatError(404, 'not_found', 'Файл вложения не найден на сервере.');
      return { file, stat, name: message.att.name, mime: message.att.mime, kind: message.att.kind };
    },

    async addSystem(conversationId, text, kind, to) {
      const rec = store.conversation(conversationId);
      if (rec) await postSystem(rec, text, kind, to);
    },

    async audience(conversationId) {
      const rec = store.conversation(conversationId);
      if (!rec) return null;
      const dir = await directory();
      return {
        title: rec.kind === 'family' ? 'Вся семья' : (rec.title ?? ''),
        ids: memberIds(rec, dir),
        kind: rec.kind,
      };
    },

    async onUserRemoved(userId) {
      store.forgetReader(userId);
      for (const rec of store.conversations()) {
        if (rec.kind !== 'group' || !rec.members.includes(userId)) continue;
        const rest = rec.members.filter((member) => member !== userId);
        store.update(rec.id, {
          members: rest,
          ownerId: rec.ownerId === userId ? (rest[0] ?? null) : rec.ownerId,
        });
        if (rest.length > 0)
          await postSystem(rec, 'Участник вышел из группы: учётная запись удалена.', 'member-left');
        announce(rec, await directory());
      }
    },
  };
  return service;
}
