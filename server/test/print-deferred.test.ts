import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PrintJobView, PrintResponse } from '../../shared/api.ts';
import { createUserStore } from '../src/auth/users.ts';
import { attr, decodeResponse, encodeRequest, type IppAttribute, IppError, OP } from '../src/print/ipp.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, removeDir, type TestApp } from './helpers.ts';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/** A printer that can be switched off and on while the portal keeps running. */
function switchablePrinter() {
  const state = { down: true };
  const seen: number[] = [];
  let polls = 0;
  const respond = (status: number, attrs: IppAttribute[]) => encodeRequest(status, 1, 'ipp://x', [], attrs);
  const transport = async (_url: string, body: Buffer) => {
    if (state.down) throw new IppError('Принтер недоступен (ECONNREFUSED)');
    const op = body.readUInt16BE(2);
    decodeResponse(body);
    seen.push(op);
    switch (op) {
      case OP.validateJob:
        return respond(0, []);
      case OP.printJob:
        return respond(0, [attr.integer('job-id', 7)]);
      case OP.getJobAttributes:
        polls += 1;
        return respond(0, [{ tag: 0x23, name: 'job-state', values: [polls >= 2 ? 9 : 5] }]);
      case OP.getPrinterAttributes:
        return respond(0, [
          { tag: 0x23, name: 'printer-state', values: [3] },
          { tag: 0x44, name: 'printer-state-reasons', values: ['none'] },
          { tag: 0x22, name: 'printer-is-accepting-jobs', values: [true] },
        ]);
      default:
        return respond(0, []);
    }
  };
  return { state, seen, transport };
}

const apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps.splice(0)) {
    await t.app.close();
    await removeDir(t.dataDir);
  }
});

async function setup() {
  const printer = switchablePrinter();
  const t = await createTestApp({
    env: { PRINTER_IPP_URL: 'https://printer.test/ipp/print' },
    ippTransport: printer.transport,
  });
  apps.push(t);
  await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
  const store = createUserStore(t.dataDir, { clock: t.clock, reloadIntervalMs: 0 });
  const mama = await store.findByUsername('mama');
  await store.update(mama?.id ?? '', { permissions: ['print'] });
  await addUser(t.dataDir, t.clock, { username: 'son', password: 'son-password-12', role: 'family' });
  const son = await store.findByUsername('son');
  await store.update(son?.id ?? '', { permissions: ['print'] });
  return {
    t,
    printer,
    admin: await cookieFor(t.app, ADMIN),
    mama: await cookieFor(t.app, FAMILY),
    son: await cookieFor(t.app, { username: 'son', password: 'son-password-12' }),
  };
}

function upload(t: TestApp, cookie: string) {
  const query = new URLSearchParams({ name: 'Справка.pdf', size: String(PDF.length) });
  return t.app.inject({
    method: 'PUT',
    url: `/api/print/jobs?${query}`,
    headers: { cookie, 'content-type': 'application/octet-stream', 'x-upload': '1' },
    payload: PDF,
  });
}
const post = (t: TestApp, cookie: string, url: string, payload: object = {}) =>
  t.app.inject({ method: 'POST', url, headers: { cookie }, payload });
const jobs = async (t: TestApp, cookie: string) =>
  ((await t.app.inject({ url: '/api/print', headers: { cookie } })).json() as PrintResponse).jobs;
async function until(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('printing while the printer is off', { timeout: 30_000 }, () => {
  it('keeps the document, prints nothing by itself, and sends it after the user chooses to wait', async () => {
    const { t, printer, mama } = await setup();
    const res = await upload(t, mama);
    expect(res.statusCode, res.body).toBe(200);
    const held = res.json() as PrintJobView;
    expect(held.state).toBe('held');
    expect(held.message).toMatch(/сохранён/);
    expect(await readdir(path.join(t.dataDir, 'print-spool'))).toHaveLength(1);

    // "Print now" is refused while the printer is away.
    const tryNow = await post(t, mama, `/api/print/jobs/${held.id}/print`, { confirm: true });
    expect(tryNow.statusCode).toBe(409);
    expect(tryNow.json().error).toBe('printer_away');

    // The printer comes back, but the user has not asked to wait: nothing is printed.
    printer.state.down = false;
    await new Promise((r) => setTimeout(r, 300));
    expect(printer.seen).not.toContain(OP.printJob);
    expect((await jobs(t, mama))[0]?.state).toBe('held');

    // Waiting needs an explicit confirmation.
    expect((await post(t, mama, `/api/print/jobs/${held.id}/defer`)).statusCode).toBe(400);
    const queued = await post(t, mama, `/api/print/jobs/${held.id}/defer`, { confirm: true });
    expect((queued.json() as PrintJobView).state).toBe('queued');
    await until(async () => (await jobs(t, mama))[0]?.state === 'completed');
    expect(printer.seen).toContain(OP.printJob);
    expect(await readdir(path.join(t.dataDir, 'print-spool'))).toEqual([]);

    const audit = (
      await t.app.inject({
        url: '/api/admin/audit?limit=20',
        headers: { cookie: await cookieFor(t.app, ADMIN) },
      })
    ).json();
    const details = audit.entries
      .filter((e: { action: string }) => e.action === 'print.submit')
      .map((e: { detail: string }) => e.detail);
    expect(details.some((d: string) => d.includes('в очередь ожидания'))).toBe(true);
    expect(details.some((d: string) => d.includes('из очереди ожидания'))).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('Справка');
  });

  it('prints from the queue only once the printer really answers', async () => {
    const { t, printer, mama } = await setup();
    const held = (await upload(t, mama)).json() as PrintJobView;
    await post(t, mama, `/api/print/jobs/${held.id}/defer`, { confirm: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(printer.seen).toEqual([]);
    expect((await jobs(t, mama))[0]?.state).toBe('queued');
    printer.state.down = false;
    await until(async () => (await jobs(t, mama))[0]?.state === 'completed');
  });

  it('lets the owner cancel a waiting document; nobody else can defer or cancel it, an admin can', async () => {
    const { t, printer, mama, son, admin } = await setup();
    const held = (await upload(t, mama)).json() as PrintJobView;
    expect((await post(t, son, `/api/print/jobs/${held.id}/defer`, { confirm: true })).statusCode).toBe(404);
    expect((await post(t, son, `/api/print/jobs/${held.id}/cancel`)).statusCode).toBe(404);
    await post(t, mama, `/api/print/jobs/${held.id}/defer`, { confirm: true });
    const canceled = (await post(t, admin, `/api/print/jobs/${held.id}/cancel`)).json() as PrintJobView;
    expect(canceled.state).toBe('canceled');
    printer.state.down = false;
    await new Promise((r) => setTimeout(r, 300));
    expect(printer.seen).not.toContain(OP.printJob);
    const spool = path.join(t.dataDir, 'print-spool');
    expect(existsSync(spool) ? await readdir(spool) : []).toEqual([]);
  });

  it('drops a document that waited longer than a day, and an undecided one after six hours', async () => {
    const { t, mama } = await setup();
    const undecided = (await upload(t, mama)).json() as PrintJobView;
    const waiting = (await upload(t, mama)).json() as PrintJobView;
    await post(t, mama, `/api/print/jobs/${waiting.id}/defer`, { confirm: true });

    t.clock.advance(7 * 60 * 60_000);
    let list = await jobs(t, mama);
    expect(list.find((j) => j.id === undecided.id)?.state).toBe('expired');
    expect(list.find((j) => j.id === waiting.id)?.state).toBe('queued');

    t.clock.advance(18 * 60 * 60_000);
    list = await jobs(t, mama);
    expect(list.find((j) => j.id === waiting.id)?.state).toBe('expired');
    await until(async () => (await readdir(path.join(t.dataDir, 'print-spool'))).length === 0);
  });

  it('does not offer the queue for a document the printer rejected', async () => {
    const { t, printer, mama } = await setup();
    printer.state.down = false;
    const ok = await upload(t, mama);
    expect((ok.json() as PrintJobView).state).toBe('checked');
    const notHeld = await post(t, mama, `/api/print/jobs/${(ok.json() as PrintJobView).id}/defer`, {
      confirm: true,
    });
    expect(notHeld.statusCode).toBe(409);
    expect(notHeld.json().error).toBe('not_held');
  });
});
