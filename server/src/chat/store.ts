/**
 * Storage of the family chat.
 *
 *   <chat dir>\index.json            conversations (who is in them), small, rewritten atomically
 *   <chat dir>\reads.json            how far each person has read each conversation
 *   <chat dir>\msg\<id>.jsonl        messages of one conversation, one JSON line each, only appended
 *   <chat dir>\files\<id>\<message>  attachments (named by message id, never by their own name)
 *
 * A message is on disk before the sender gets the answer. A deletion is a new line, not an edit, so
 * a crash can lose at most the line being written; a half-written last line is ignored on load.
 * The folder is part of the daily backup (family data).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ChatAttachmentKind, ChatKind, ChatSystemKind } from '../../../shared/api.ts';
import { newId } from '../lib/ids.ts';
import { createSerialQueue, errorCode, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { type Clock, isoNow } from '../lib/time.ts';

export const FAMILY_ID = 'family';
const ID_RE = /^(family|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function isConversationId(value: string): boolean {
  return ID_RE.test(value);
}

export interface ConversationRec {
  id: string;
  kind: ChatKind;
  title: string | null;
  /** Empty for `family` (everybody belongs). */
  members: string[];
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentRec {
  name: string;
  size: number;
  mime: string;
  kind: ChatAttachmentKind;
}

export interface MessageRec {
  id: string;
  seq: number;
  at: string;
  /** User id; null for messages made by the server. */
  sender: string | null;
  text: string;
  att: AttachmentRec | null;
  sys: ChatSystemKind | null;
  /** The sender's own id, to recognise a retry of the same message. */
  cid: string | null;
  /** Only these people count the line as unread (a missed call concerns those who missed it). */
  to: string[] | null;
  deletedAt: string | null;
}

const conversationSchema = z.object({
  id: z.string().regex(ID_RE),
  kind: z.enum(['family', 'direct', 'group']),
  title: z.string().nullable(),
  members: z.array(z.string()),
  ownerId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const indexSchema = z.object({ version: z.literal(1), conversations: z.array(conversationSchema) });
const readsSchema = z.object({
  version: z.literal(1),
  reads: z.record(z.string(), z.record(z.string(), z.number().int().min(0))),
});

const messageLineSchema = z.object({
  t: z.literal('m'),
  id: z.string(),
  seq: z.number().int().min(1),
  at: z.string(),
  sender: z.string().nullable(),
  text: z.string(),
  att: z
    .object({
      name: z.string(),
      size: z.number(),
      mime: z.string(),
      kind: z.enum(['image', 'video', 'audio', 'file']),
    })
    .nullable(),
  sys: z.enum(['created', 'member-added', 'member-left', 'member-removed', 'call', 'call-missed']).nullable(),
  cid: z.string().nullable(),
  to: z.array(z.string()).nullable().optional(),
});
const deleteLineSchema = z.object({ t: z.literal('d'), id: z.string(), at: z.string() });

export interface NewMessage {
  sender: string | null;
  text: string;
  att?: AttachmentRec | null;
  sys?: ChatSystemKind | null;
  cid?: string | null;
  to?: string[] | null;
  /** Used for the attachment's file name; generated when absent. */
  id?: string;
}

export interface ChatStore {
  load(): Promise<void>;
  conversations(): ConversationRec[];
  conversation(id: string): ConversationRec | undefined;
  create(input: Omit<ConversationRec, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): ConversationRec;
  update(
    id: string,
    patch: Partial<Pick<ConversationRec, 'title' | 'members' | 'ownerId'>>,
  ): ConversationRec | undefined;
  messages(conversationId: string): Promise<readonly MessageRec[]>;
  append(conversationId: string, input: NewMessage): Promise<MessageRec>;
  markDeleted(conversationId: string, messageId: string): Promise<MessageRec | undefined>;
  readOf(conversationId: string): Record<string, number>;
  setRead(conversationId: string, userId: string, seq: number): boolean;
  forgetReader(userId: string): void;
  attachmentPath(conversationId: string, messageId: string): string;
  attachmentsDir(conversationId: string): string;
  idle(): Promise<void>;
}

export interface ChatStoreOptions {
  dir: string;
  clock: Clock;
  onError?: (message: string) => void;
}

export function createChatStore(options: ChatStoreOptions): ChatStore {
  const { dir, clock } = options;
  const indexFile = path.join(dir, 'index.json');
  const readsFile = path.join(dir, 'reads.json');
  const queue = createSerialQueue();
  const conversationMap = new Map<string, ConversationRec>();
  const reads = new Map<string, Map<string, number>>();
  const loaded = new Map<string, Promise<MessageRec[]>>();
  let timer: NodeJS.Timeout | null = null;
  let dirty = false;

  function warn(message: string): void {
    options.onError?.(message);
  }

  function saveSoon(): void {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, 300);
    timer.unref();
  }

  function flush(): Promise<void> {
    if (!dirty) return queue.idle();
    dirty = false;
    const index = { version: 1 as const, conversations: [...conversationMap.values()] };
    const readState = {
      version: 1 as const,
      reads: Object.fromEntries([...reads].map(([id, map]) => [id, Object.fromEntries(map)])),
    };
    return queue
      .run(async () => {
        await writeJsonAtomic(indexFile, index);
        await writeJsonAtomic(readsFile, readState);
      })
      .catch((error: unknown) => warn(`Не удалось сохранить чат: ${(error as Error).message}`));
  }

  async function readMessages(conversationId: string): Promise<MessageRec[]> {
    let text: string;
    try {
      text = await fsp.readFile(path.join(dir, 'msg', `${conversationId}.jsonl`), 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    const byId = new Map<string, MessageRec>();
    const list: MessageRec[] = [];
    let bad = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        bad += 1;
        continue;
      }
      const message = messageLineSchema.safeParse(json);
      if (message.success) {
        const rec: MessageRec = {
          ...message.data,
          att: message.data.att,
          to: message.data.to ?? null,
          deletedAt: null,
        };
        byId.set(rec.id, rec);
        list.push(rec);
        continue;
      }
      const removal = deleteLineSchema.safeParse(json);
      if (removal.success) {
        const target = byId.get(removal.data.id);
        if (target) {
          target.deletedAt = removal.data.at;
          target.text = '';
          target.att = null;
        }
        continue;
      }
      bad += 1;
    }
    if (bad > 0) warn(`В переписке ${conversationId} пропущено повреждённых строк: ${bad}.`);
    return list;
  }

  function messagesOf(conversationId: string): Promise<MessageRec[]> {
    let pending = loaded.get(conversationId);
    if (!pending) {
      pending = readMessages(conversationId);
      loaded.set(conversationId, pending);
      pending.catch(() => loaded.delete(conversationId));
    }
    return pending;
  }

  async function appendLine(conversationId: string, line: object): Promise<void> {
    const folder = path.join(dir, 'msg');
    await fsp.mkdir(folder, { recursive: true });
    await fsp.appendFile(path.join(folder, `${conversationId}.jsonl`), `${JSON.stringify(line)}\n`, 'utf8');
  }

  return {
    async load() {
      await fsp.mkdir(dir, { recursive: true });
      for (const [file, kind] of [
        [indexFile, 'index'],
        [readsFile, 'reads'],
      ] as const) {
        let data: unknown;
        try {
          data = await readJsonFile(file);
        } catch (error) {
          throw new Error(`Файл ${path.basename(file)} чата повреждён: ${(error as Error).message}`);
        }
        if (data === undefined) continue;
        if (kind === 'index') {
          const parsed = indexSchema.safeParse(data);
          if (!parsed.success) throw new Error('Файл index.json чата имеет неверный формат.');
          for (const rec of parsed.data.conversations) conversationMap.set(rec.id, rec);
        } else {
          const parsed = readsSchema.safeParse(data);
          if (!parsed.success) throw new Error('Файл reads.json чата имеет неверный формат.');
          for (const [id, map] of Object.entries(parsed.data.reads))
            reads.set(id, new Map(Object.entries(map)));
        }
      }
    },

    conversations: () => [...conversationMap.values()],
    conversation: (id) => conversationMap.get(id),

    create(input) {
      const now = isoNow(clock);
      const rec: ConversationRec = {
        id: input.id ?? newId(),
        kind: input.kind,
        title: input.title,
        members: [...input.members],
        ownerId: input.ownerId,
        createdAt: now,
        updatedAt: now,
      };
      conversationMap.set(rec.id, rec);
      saveSoon();
      return rec;
    },

    update(id, patch) {
      const rec = conversationMap.get(id);
      if (!rec) return undefined;
      if (patch.title !== undefined) rec.title = patch.title;
      if (patch.members !== undefined) rec.members = [...patch.members];
      if (patch.ownerId !== undefined) rec.ownerId = patch.ownerId;
      rec.updatedAt = isoNow(clock);
      saveSoon();
      return rec;
    },

    messages: (conversationId) => messagesOf(conversationId),

    append(conversationId, input) {
      // One writer at a time per store: the sequence number and the line on disk stay in step.
      return queue.run(async () => {
        const list = await messagesOf(conversationId);
        const rec: MessageRec = {
          id: input.id ?? newId(),
          seq: (list[list.length - 1]?.seq ?? 0) + 1,
          at: isoNow(clock),
          sender: input.sender,
          text: input.text,
          att: input.att ?? null,
          sys: input.sys ?? null,
          cid: input.cid ?? null,
          to: input.to ?? null,
          deletedAt: null,
        };
        await appendLine(conversationId, {
          t: 'm',
          id: rec.id,
          seq: rec.seq,
          at: rec.at,
          sender: rec.sender,
          text: rec.text,
          att: rec.att,
          sys: rec.sys,
          cid: rec.cid,
          ...(rec.to ? { to: rec.to } : {}),
        });
        list.push(rec);
        const conversation = conversationMap.get(conversationId);
        if (conversation) {
          conversation.updatedAt = rec.at;
          saveSoon();
        }
        return rec;
      });
    },

    markDeleted(conversationId, messageId) {
      return queue.run(async () => {
        const list = await messagesOf(conversationId);
        const rec = list.find((item) => item.id === messageId);
        if (!rec || rec.deletedAt) return undefined;
        const at = isoNow(clock);
        await appendLine(conversationId, { t: 'd', id: messageId, at });
        rec.deletedAt = at;
        rec.text = '';
        rec.att = null;
        return rec;
      });
    },

    readOf(conversationId) {
      return Object.fromEntries(reads.get(conversationId) ?? []);
    },

    setRead(conversationId, userId, seq) {
      let map = reads.get(conversationId);
      if (!map) {
        map = new Map();
        reads.set(conversationId, map);
      }
      if ((map.get(userId) ?? 0) >= seq) return false;
      map.set(userId, seq);
      saveSoon();
      return true;
    },

    forgetReader(userId) {
      for (const map of reads.values()) map.delete(userId);
      saveSoon();
    },

    attachmentsDir: (conversationId) => path.join(dir, 'files', conversationId),
    attachmentPath: (conversationId, messageId) => path.join(dir, 'files', conversationId, messageId),

    async idle() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
      await queue.idle();
    },
  };
}
