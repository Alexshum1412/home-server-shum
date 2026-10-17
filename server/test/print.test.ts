import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PrintJobView, PrintResponse } from '../../shared/api.ts';
import { createUserStore } from '../src/auth/users.ts';
import { attr, decodeResponse, encodeRequest, type IppAttribute, IppError, OP } from '../src/print/ipp.ts';
import { sniffPrintable } from '../src/print/queue.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, removeDir, type TestApp } from './helpers.ts';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

interface Seen {
  op: number;
  attrs: Map<string, unknown[]>;
  document: Buffer;
}

/** A fake IPP printer: records requests, answers like the HP (job-id 42, then completed). */
function fakePrinter(opts: { validateStatus?: number; markerLevels?: number[]; down?: boolean } = {}) {
  const seen: Seen[] = [];
  let polls = 0;
  const respond = (status: number, groupAttrs: IppAttribute[]) => {
    const buf = encodeRequest(status, 1, 'ipp://x', [], groupAttrs);
    return buf;
  };
  const transport = async (_url: string, body: Buffer) => {
    if (opts.down) throw new IppError('Принтер недоступен (ECONNREFUSED)');
    const op = body.readUInt16BE(2);
    const parsed = decodeResponse(body);
    // The document (if any) follows the end-of-attributes tag.
    const end = body.indexOf(0x03, 8);
    seen.push({
      op,
      attrs: parsed.attrs,
      document: body.subarray(body.lastIndexOf(Buffer.from([0x03])) + 1),
    });
    void end;
    switch (op) {
      case OP.validateJob:
        return respond(opts.validateStatus ?? 0, []);
      case OP.printJob:
        return respond(0, [attr.integer('job-id', 42), { tag: 0x23, name: 'job-state', values: [3] }]);
      case OP.getJobAttributes:
        polls += 1;
        return respond(0, [{ tag: 0x23, name: 'job-state', values: [polls >= 2 ? 9 : 5] }]);
      case OP.cancelJob:
        return respond(0, []);
      case OP.getPrinterAttributes:
        return respond(0, [
          { tag: 0x23, name: 'printer-state', values: [3] },
          { tag: 0x44, name: 'printer-state-reasons', values: ['none'] },
          { tag: 0x22, name: 'printer-is-accepting-jobs', values: [true] },
          {
            tag: 0x41,
            name: 'marker-names',
            values: ['Black Cartridge HP W2210A', 'Cyan Cartridge HP W2211A'],
          },
          { tag: 0x41, name: 'marker-colors', values: ['#000000', '#00FFFF'] },
          { tag: 0x21, name: 'marker-levels', values: opts.markerLevels ?? [-2, -2] },
        ]);
      default:
        return respond(0x0501, []);
    }
  };
  return { seen, transport };
}

const apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps.splice(0)) {
    await t.app.close();
    await removeDir(t.dataDir);
  }
});

async function app(
  printer = fakePrinter(),
  env: Record<string, string> = { PRINTER_IPP_URL: 'https://printer.test/ipp/print' },
) {
  const t = await createTestApp({ env, ippTransport: printer.transport });
  apps.push(t);
  await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
  return { t, printer, admin: await cookieFor(t.app, ADMIN), mama: await cookieFor(t.app, FAMILY) };
}

function upload(t: TestApp, cookie: string, body: Buffer, q: Record<string, string> = {}) {
  const query = new URLSearchParams({ name: 'Справка.pdf', size: String(body.length), ...q });
  return t.app.inject({
    method: 'PUT',
    url: `/api/print/jobs?${query}`,
    headers: { cookie, 'content-type': 'application/octet-stream', 'x-upload': '1' },
    payload: body,
  });
}

const post = (t: TestApp, cookie: string, url: string, payload: object = {}) =>
  t.app.inject({ method: 'POST', url, headers: { cookie }, payload });

async function until(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('printing', { timeout: 30_000 }, () => {
  it('recognises only PDF and JPEG by content', () => {
    expect(sniffPrintable(PDF)).toBe('pdf');
    expect(sniffPrintable(JPEG)).toBe('jpeg');
    expect(sniffPrintable(Buffer.from('MZ\x90\x00binary'))).toBeNull();
    expect(sniffPrintable(Buffer.from('<html>'))).toBeNull();
  });

  it('validates first, prints only after confirmation, follows the job to completion', async () => {
    const { t, admin, printer } = await app();
    const res = await upload(t, admin, PDF, {
      copies: '2',
      sides: 'two-sided-long-edge',
      color: 'monochrome',
    });
    expect(res.statusCode, res.body).toBe(200);
    const job = res.json() as PrintJobView;
    expect(job).toMatchObject({ state: 'checked', format: 'pdf', copies: 2, sides: 'two-sided-long-edge' });
    expect(printer.seen.map((s) => s.op)).toEqual([OP.validateJob]);
    expect(printer.seen[0]?.attrs.get('document-format')).toEqual(['application/pdf']);
    expect(printer.seen[0]?.attrs.get('sides')).toEqual(['two-sided-long-edge']);
    expect((await post(t, admin, `/api/print/jobs/${job.id}/print`)).statusCode).toBe(400);
    const sent = await post(t, admin, `/api/print/jobs/${job.id}/print`, { confirm: true });
    expect((sent.json() as PrintJobView).state).toBe('sent');
    const printed = printer.seen.find((s) => s.op === OP.printJob);
    expect(printed?.document.equals(PDF)).toBe(true);
    expect(printed?.attrs.get('copies')).toEqual([2]);
    await until(async () => {
      const list = (
        await t.app.inject({ url: '/api/print', headers: { cookie: admin } })
      ).json() as PrintResponse;
      return list.jobs[0]?.state === 'completed';
    });
    expect(await readdir(path.join(t.dataDir, 'print-spool'))).toEqual([]);
    const audit = (
      await t.app.inject({ url: '/api/admin/audit?limit=20', headers: { cookie: admin } })
    ).json();
    const submit = audit.entries.find((e: { action: string }) => e.action === 'print.submit');
    expect(submit.detail).toMatch(/PDF, \d+ КБ, копий: 2/);
    expect(JSON.stringify(audit)).not.toContain('Справка');
    // Printing it again is not possible.
    expect((await post(t, admin, `/api/print/jobs/${job.id}/print`, { confirm: true })).statusCode).toBe(409);
  });

  it('refuses other formats, programs, oversize files and what the printer rejects; nothing is spooled', async () => {
    const { t, admin } = await app(fakePrinter({ validateStatus: 0x040b }), {
      PRINTER_IPP_URL: 'https://printer.test/ipp/print',
      PRINT_MAX_MB: '1',
    });
    expect((await upload(t, admin, Buffer.from('Просто текст'))).json().error).toBe('unsupported_format');
    expect((await upload(t, admin, Buffer.from('MZ\x90\x00 program'))).json().error).toBe(
      'unsupported_format',
    );
    expect((await upload(t, admin, Buffer.alloc(2 * 1024 * 1024, 0x25))).statusCode).toBe(413);
    const rejected = await upload(t, admin, PDF);
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().message).toMatch(/настройки печати/);
    const spool = path.join(t.dataDir, 'print-spool');
    expect(existsSync(spool) ? await readdir(spool) : []).toEqual([]);
  });

  it('needs the print right; members cannot touch each other’s jobs; cancel goes to the printer', async () => {
    const { t, admin, mama, printer } = await app();
    expect((await upload(t, mama, PDF)).statusCode).toBe(403);
    const store = createUserStore(t.dataDir, { clock: t.clock, reloadIntervalMs: 0 });
    const user = await store.findByUsername('mama');
    await store.update(user?.id ?? '', { permissions: ['print'] });
    const job = (await upload(t, mama, JPEG, { name: 'фото.jpg' })).json() as PrintJobView;
    expect(job.format).toBe('jpeg');
    await addUser(t.dataDir, t.clock, { username: 'son', password: 'son-password-12', role: 'family' });
    const sonUser = await store.findByUsername('son');
    await store.update(sonUser?.id ?? '', { permissions: ['print'] });
    const son = await cookieFor(t.app, { username: 'son', password: 'son-password-12' });
    expect((await post(t, son, `/api/print/jobs/${job.id}/print`, { confirm: true })).statusCode).toBe(404);
    const list = (
      await t.app.inject({ url: '/api/print', headers: { cookie: son } })
    ).json() as PrintResponse;
    expect(list.jobs).toEqual([]);
    await post(t, mama, `/api/print/jobs/${job.id}/print`, { confirm: true });
    const canceled = (await post(t, admin, `/api/print/jobs/${job.id}/cancel`)).json() as PrintJobView;
    expect(canceled.state).toBe('canceled');
    expect(printer.seen.some((s) => s.op === OP.cancelJob && s.attrs.get('job-id')?.[0] === 42)).toBe(true);
  });

  it('shows toner levels only when the printer reports them; an offline printer is said plainly', async () => {
    const unknown = await app(fakePrinter({ markerLevels: [-2, -2] }));
    const a = (
      (
        await unknown.t.app.inject({ url: '/api/print', headers: { cookie: unknown.mama } })
      ).json() as PrintResponse
    ).printer;
    expect(a).toMatchObject({ configured: true, reachable: true, state: 'idle', acceptingJobs: true });
    expect(a.markers.map((m) => m.levelPercent)).toEqual([null, null]);
    const known = await app(fakePrinter({ markerLevels: [55, 10] }));
    const b = (
      (
        await known.t.app.inject({ url: '/api/print', headers: { cookie: known.mama } })
      ).json() as PrintResponse
    ).printer;
    expect(b.markers.map((m) => m.levelPercent)).toEqual([55, 10]);
    const down = await app(fakePrinter({ down: true }));
    const c = (
      (await down.t.app.inject({ url: '/api/print', headers: { cookie: down.mama } })).json() as PrintResponse
    ).printer;
    expect(c).toMatchObject({ reachable: false });
    expect(c.message).toMatch(/недоступен/);
  });

  it('says so when printing is not configured', async () => {
    const { t, admin } = await app(fakePrinter(), {});
    const body = (
      await t.app.inject({ url: '/api/print', headers: { cookie: admin } })
    ).json() as PrintResponse;
    expect(body.printer.configured).toBe(false);
    expect((await upload(t, admin, PDF)).statusCode).toBe(503);
  });
});

describe('IPP transport', () => {
  it('sends a document chunked (the HP aborts jobs whose document has a Content-Length) and control messages with a length', async () => {
    const { createServer } = await import('node:http');
    const { httpTransport } = await import('../src/print/ipp.ts');
    const seen: Array<{ te: string | undefined; cl: string | undefined; bytes: number }> = [];
    const server = createServer((req, res) => {
      let bytes = 0;
      req.on('data', (c: Buffer) => {
        bytes += c.length;
      });
      req.on('end', () => {
        seen.push({ te: req.headers['transfer-encoding'], cl: req.headers['content-length'], bytes });
        res.writeHead(200, { 'content-type': 'application/ipp' }).end(encodeRequest(0, 1, 'ipp://x', []));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      const body = Buffer.alloc(200_000, 1);
      await httpTransport(`http://127.0.0.1:${port}/ipp/print`, body, 5000, true);
      await httpTransport(`http://127.0.0.1:${port}/ipp/print`, Buffer.alloc(100, 1), 5000, false);
      expect(seen[0]).toEqual({ te: 'chunked', cl: undefined, bytes: 200_000 });
      expect(seen[1]).toEqual({ te: undefined, cl: '100', bytes: 100 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('printer status never blocks the page', () => {
  it('answers «checking» at once while a slow printer is probed, then serves the result', async () => {
    const { createPrintQueue } = await import('../src/print/queue.ts');
    const { makeTempDir } = await import('./helpers.ts');
    const dir = await makeTempDir('fd-print-');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = fakePrinter();
    const queue = createPrintQueue({
      dataDir: dir,
      printerUrl: 'https://printer.test/ipp/print',
      maxBytes: 1024 * 1024,
      clock: () => new Date(),
      transport: async (url, body) => {
        await gate;
        return slow.transport(url, body);
      },
    });
    try {
      const started = Date.now();
      const first = await queue.printerStatus();
      expect(Date.now() - started).toBeLessThan(500);
      expect(first).toMatchObject({ configured: true, reachable: null, message: 'Проверяем принтер…' });
      release();
      await until(async () => (await queue.printerStatus()).reachable === true);
    } finally {
      await queue.stop();
      await removeDir(dir);
    }
  });
});
