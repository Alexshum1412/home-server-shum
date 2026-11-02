import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, type Guards } from '../auth/guards.ts';
import type { UserStore } from '../auth/users.ts';
import type { Config } from '../config.ts';
import { requestChannel } from '../lib/channel.ts';
import { sendError } from '../lib/http.ts';
import type { OliviaChat } from './chat.ts';

export function registerOliviaChatRoutes(
  app: FastifyInstance,
  deps: { chat: OliviaChat; users: Pick<UserStore, 'findByUsername'>; guards: Guards; config: Config },
): void {
  const { chat, users, guards, config } = deps;
  const running = new Map<string, AbortController>();

  app.post('/api/olivia/chat/stop', { preHandler: guards.requireUser }, async (request, reply) => {
    running.get(currentUser(request).username)?.abort();
    return reply.code(204).send();
  });

  app.get('/api/olivia/chat', { preHandler: guards.requireUser }, async (request, reply) => {
    const me = currentUser(request);
    return reply.header('cache-control', 'no-store').send({
      turns: await chat.history(me.username),
      models: chat.modelsState(),
      pending: chat.pending(me.username),
    });
  });

  app.post('/api/olivia/chat/clear', { preHandler: guards.requireUser }, async (request, reply) => {
    await chat.clear(currentUser(request).username);
    return reply.code(204).send();
  });

  // The answer comes line by line (one JSON object per line): status, pieces of text, the end.
  app.post('/api/olivia/chat', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = z
      .object({
        message: z.string().min(1).max(2000),
        smart: z.boolean().optional(),
        web: z.boolean().optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Напишите сообщение.');
    const me = currentUser(request);
    const stored = await users.findByUsername(me.username);
    if (!stored) return sendError(reply, 404, 'not_found', 'Учётная запись не найдена.');
    if (chat.isBusy(me.username)) {
      return sendError(reply, 429, 'busy', 'Оливия ещё отвечает на прошлое сообщение. Подождите немного.');
    }
    const stream = new PassThrough();
    const controller = new AbortController();
    // The answer is made to the end even when the person leaves the page (it is saved in the talk); only «Стоп» stops it.
    running.get(me.username)?.abort();
    running.set(me.username, controller);
    const send = (event: object) => {
      if (!stream.destroyed) stream.write(`${JSON.stringify(event)}\n`);
    };
    void (async () => {
      try {
        const result = await chat.converse(stored, parsed.data.message, {
          ...(parsed.data.smart === undefined ? {} : { smart: parsed.data.smart }),
          ...(parsed.data.web === undefined ? {} : { web: parsed.data.web }),
          channel: requestChannel(request, config) === 'public' ? 'public' : 'private',
          signal: controller.signal,
          onStatus: (text) => send({ t: 'status', text }),
          onToken: (piece) => send({ t: 'token', text: piece }),
        });
        if (result.kind === 'tool') send({ t: 'answer', answer: result.answer });
        else send({ t: 'end', model: result.model, text: result.text });
      } catch (error) {
        send({ t: 'error', message: error instanceof Error ? error.message : 'Не получилось ответить.' });
      } finally {
        if (running.get(me.username) === controller) running.delete(me.username);
        stream.end();
      }
    })();
    return reply
      .header('cache-control', 'no-store')
      .header('x-accel-buffering', 'no')
      .type('application/x-ndjson; charset=utf-8')
      .send(stream);
  });
}
