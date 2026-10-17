import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage, type Storage } from '../src/files/storage.ts';
import { exportSpace, importFolder, monthOf } from '../src/files/transfer.ts';
import { makeTempDir, removeDir } from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]);

async function setup() {
  const filesDir = await makeTempDir('fd-tfiles-');
  const photosDir = await makeTempDir('fd-tphotos-');
  const source = await makeTempDir('fd-tsource-');
  cleanup.push(async () => {
    for (const dir of [filesDir, photosDir, source]) await removeDir(dir);
  });
  const storage: Storage = createStorage({
    filesRoot: filesDir,
    photosRoot: photosDir,
    minFreeBytes: 0,
    maxUploadBytes: 10 * 1024 ** 2,
    freeBytes: async () => 500 * 1024 ** 3,
  });
  return { storage, filesDir, photosDir, source };
}

async function tree(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tree(full, base)));
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

describe('import into «Файлы»', () => {
  it('copies the structure, refuses programs, keeps the source and does nothing twice', async () => {
    const { storage, filesDir, source } = await setup();
    await mkdir(path.join(source, 'Школа', '2026'), { recursive: true });
    await writeFile(path.join(source, 'Школа', '2026', 'заметка.txt'), 'урок');
    await writeFile(path.join(source, 'Школа', 'расписание.pdf'), '%PDF-1.4');
    await writeFile(path.join(source, 'setup.exe'), 'MZ-program');
    await writeFile(path.join(source, 'run.bat'), 'echo hi');
    await writeFile(path.join(source, 'Thumbs.db'), 'junk');
    await writeFile(path.join(source, '.hidden'), 'junk');
    await writeFile(path.join(source, 'renamed.txt'), Buffer.from('MZ\u0090\u0000program'));

    const first = await importFolder({ storage, username: 'mama', root: 'files', space: 'personal', source });
    expect(first.imported).toBe(2); // the program hidden under a .txt name is refused by its content
    expect(first.skipped.map((s) => s.name).sort()).toEqual(['renamed.txt', 'run.bat', 'setup.exe'].sort());
    expect(first.failed).toEqual([]);
    const base = path.join(filesDir, 'users', 'mama');
    expect(await tree(base)).toEqual(['Школа/2026/заметка.txt', 'Школа/расписание.pdf'].sort());
    expect(await readFile(path.join(base, 'Школа', '2026', 'заметка.txt'), 'utf8')).toBe('урок');
    // The source is untouched.
    expect(await tree(source)).toContain('setup.exe');

    const second = await importFolder({
      storage,
      username: 'mama',
      root: 'files',
      space: 'personal',
      source,
    });
    expect(second.imported).toBe(0);
    expect(second.existing).toBe(2);
    expect(await tree(base)).toEqual(['Школа/2026/заметка.txt', 'Школа/расписание.pdf'].sort());
  });

  it('puts the content into a chosen folder of the shared space and reports a dry run without copying', async () => {
    const { storage, filesDir, source } = await setup();
    await writeFile(path.join(source, 'договор.pdf'), '%PDF');
    const dry = await importFolder({
      storage,
      username: 'papa',
      root: 'files',
      space: 'shared',
      source,
      to: 'Документы/Сканы',
      dryRun: true,
    });
    expect(dry.imported).toBe(1);
    expect(await readdir(filesDir)).toEqual([]);
    await importFolder({
      storage,
      username: 'papa',
      root: 'files',
      space: 'shared',
      source,
      to: 'Документы/Сканы',
    });
    expect(await tree(path.join(filesDir, 'shared'))).toEqual(['Документы/Сканы/договор.pdf']);
  });

  it('does not overwrite a different file with the same name', async () => {
    const { storage, filesDir, source } = await setup();
    await mkdir(path.join(filesDir, 'users', 'mama'), { recursive: true });
    await writeFile(path.join(filesDir, 'users', 'mama', 'a.txt'), 'old content');
    await writeFile(path.join(source, 'a.txt'), 'new');
    const report = await importFolder({
      storage,
      username: 'mama',
      root: 'files',
      space: 'personal',
      source,
    });
    expect(report.imported).toBe(1);
    expect(await tree(path.join(filesDir, 'users', 'mama'))).toEqual(['a (2).txt', 'a.txt']);
    expect(await readFile(path.join(filesDir, 'users', 'mama', 'a.txt'), 'utf8')).toBe('old content');
  });

  it('says clearly when the source folder does not exist', async () => {
    const { storage } = await setup();
    await expect(
      importFolder({
        storage,
        username: 'mama',
        root: 'files',
        space: 'personal',
        source: 'C:\\no-such-folder-xyz',
      }),
    ).rejects.toThrow(/не найдена/);
  });
});

describe('import into «Фото»', () => {
  it('files real pictures by month of the file date and skips everything that is not a photo or video', async () => {
    const { storage, photosDir, source } = await setup();
    await mkdir(path.join(source, 'DCIM', '100APPLE'), { recursive: true });
    const october = new Date(2026, 9, 11, 12, 0, 0);
    const march = new Date(2025, 2, 3, 12, 0, 0);
    await writeFile(path.join(source, 'DCIM', '100APPLE', 'IMG_0001.JPG'), JPEG);
    await writeFile(path.join(source, 'DCIM', 'IMG_0002.JPG'), JPEG);
    await utimes(path.join(source, 'DCIM', '100APPLE', 'IMG_0001.JPG'), october, october);
    await utimes(path.join(source, 'DCIM', 'IMG_0002.JPG'), march, march);
    await writeFile(path.join(source, 'DCIM', 'notes.txt'), 'not a photo');
    await writeFile(path.join(source, 'DCIM', 'fake.jpg'), '<html>not really a picture</html>');

    const report = await importFolder({
      storage,
      username: 'mama',
      root: 'photos',
      space: 'personal',
      source,
    });
    expect(report.imported).toBe(2);
    expect(report.skipped.map((s) => s.name).sort()).toEqual(['fake.jpg', 'notes.txt']);
    expect(report.failed).toEqual([]);
    expect(await tree(path.join(photosDir, 'users', 'mama'))).toEqual([
      `${monthOf(march)}/IMG_0002.JPG`,
      `${monthOf(october)}/IMG_0001.JPG`,
    ]);
    expect(monthOf(october)).toBe('2026-10');
  });
});

describe('export', () => {
  it('copies a space into a new folder, leaves the trash behind and the storage untouched', async () => {
    const { storage, filesDir, source } = await setup();
    const home = path.join(filesDir, 'users', 'mama');
    await mkdir(path.join(home, 'Школа'), { recursive: true });
    await writeFile(path.join(home, 'Школа', 'a.txt'), 'A');
    await writeFile(path.join(home, 'b.txt'), 'B');
    await mkdir(path.join(filesDir, '.trash', 'users', 'mama'), { recursive: true });
    await writeFile(path.join(filesDir, '.trash', 'users', 'mama', 'old.txt'), 'trashed');
    await writeFile(path.join(home, '.upload-temp'), 'partial');

    const destination = path.join(source, 'out');
    const report = await exportSpace({
      storage,
      username: 'mama',
      root: 'files',
      space: 'personal',
      destination,
    });
    expect(report.files).toBe(2);
    expect(await tree(destination)).toEqual(['b.txt', 'Школа/a.txt']);
    expect(await tree(home)).toContain('b.txt');

    // A second export into the now non-empty folder is refused.
    await expect(
      exportSpace({ storage, username: 'mama', root: 'files', space: 'personal', destination }),
    ).rejects.toThrow(/не пустая/);
  });

  it('refuses paths that leave the space and destinations inside the copied folder', async () => {
    const { storage, filesDir, source } = await setup();
    await mkdir(path.join(filesDir, 'users', 'mama'), { recursive: true });
    await expect(
      exportSpace({
        storage,
        username: 'mama',
        root: 'files',
        space: 'personal',
        from: '../papa',
        destination: path.join(source, 'x'),
      }),
    ).rejects.toThrow(/Недопустимый путь/);
    await expect(
      exportSpace({
        storage,
        username: 'mama',
        root: 'files',
        space: 'personal',
        destination: path.join(filesDir, 'users', 'mama', 'inside'),
      }),
    ).rejects.toThrow(/внутри копируемой папки/);
  });
});
