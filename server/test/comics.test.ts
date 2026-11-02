import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listComics, registerComicsRoutes, resolveBook } from '../src/comics/routes.ts';
import { readZipEntries, readZipEntry } from '../src/comics/zip.ts';

/** A zip file made by hand: [name, bytes, deflate?]. */
function makeZip(files: Array<[string, Buffer, boolean?]>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data, deflate] of files) {
    const body = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(deflate ? 8 : 0, 10);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'comics-'));
  await mkdir(path.join(dir, 'Серия'), { recursive: true });
  await writeFile(
    path.join(dir, 'Серия', 'Том 1.cbz'),
    makeZip([
      ['10.jpg', Buffer.from('ten'), true],
      ['2.jpg', Buffer.from('two')],
      ['1.png', Buffer.from('one'), true],
      ['notes.txt', Buffer.from('skip me')],
    ]),
  );
  await writeFile(path.join(dir, 'Руководство.pdf'), '%PDF-1.4 test');
  await writeFile(path.join(dir, 'secret.txt'), 'no');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('zip reader', () => {
  it('reads stored and deflated entries', async () => {
    const file = path.join(dir, 'Серия', 'Том 1.cbz');
    const entries = await readZipEntries(file);
    expect(entries.map((entry) => entry.name)).toEqual(['10.jpg', '2.jpg', '1.png', 'notes.txt']);
    expect((await readZipEntry(file, entries[0]!)).toString()).toBe('ten');
    expect((await readZipEntry(file, entries[1]!)).toString()).toBe('two');
  });
});

describe('comics routes', () => {
  const guards = { requireUser: async () => undefined } as never;
  const make = async () => {
    const app = Fastify();
    registerComicsRoutes(app, { guards, dir });
    await app.ready();
    return app;
  };

  it('lists books from folders, only comics and pdf', async () => {
    const books = await listComics(dir);
    expect(books.map((b) => `${b.folder}|${b.title}|${b.kind}`)).toEqual([
      '|Руководство|pdf',
      'Серия|Том 1|cbz',
    ]);
  });

  it('serves pages in natural order and refuses paths outside the folder', async () => {
    const app = await make();
    const book = (await listComics(dir)).find((b) => b.kind === 'cbz')!;
    const pages = (await app.inject({ url: `/api/comics/${book.id}/pages` })).json() as { pages: number };
    expect(pages.pages).toBe(3);
    const first = await app.inject({ url: `/api/comics/${book.id}/page/0` });
    expect(first.body).toBe('one');
    expect(first.headers['content-type']).toContain('image/png');
    expect((await app.inject({ url: `/api/comics/${book.id}/page/2` })).body).toBe('ten');
    expect((await app.inject({ url: `/api/comics/${book.id}/page/3` })).statusCode).toBe(404);
    const outside = Buffer.from('..\\secret.txt').toString('base64url');
    expect((await app.inject({ url: `/api/comics/${outside}/pages` })).statusCode).toBe(404);
    const text = Buffer.from('secret.txt').toString('base64url');
    expect(resolveBook(dir, text)).toBeNull();
    await app.close();
  });

  it('serves a pdf as a pdf', async () => {
    const app = await make();
    const pdf = (await listComics(dir)).find((b) => b.kind === 'pdf')!;
    const response = await app.inject({ url: `/api/comics/${pdf.id}/file` });
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.body).toContain('%PDF');
    await app.close();
  });
});
