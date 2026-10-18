import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packTree, unpackTree } from '../src/backup/archive.ts';
import {
  CHUNK_BYTES,
  CryptError,
  decryptStream,
  encryptStream,
  formatRecoveryCode,
  generateKey,
  parseRecoveryCode,
  readKeyFile,
  writeNewKeyFile,
} from '../src/backup/crypt.ts';
import {
  listOffsite,
  packOffsite,
  pruneOffsite,
  restoreOffsite,
  runOffsiteIfDue,
  testRestoreOffsite,
  verifyOffsiteFile,
} from '../src/backup/offsite.ts';
import { listSnapshots } from '../src/backup/retention.ts';
import { type BackupDeps, type BackupSettings, runBackup } from '../src/backup/run.ts';
import { BACKUP_STATUS_FILE } from '../src/backup/status.ts';
import { readBackupStatus } from '../src/system/backup.ts';
import { createFakeClock, type FakeClock, makeTempDir, removeDir } from './helpers.ts';

const NOW = '2026-10-18T10:00:00.000Z';

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
}

async function* once(buffer: Buffer): AsyncGenerator<Buffer> {
  yield buffer;
}

/** The container cut into 3 pieces at awkward places, as a file read would deliver it. */
async function* pieces(buffer: Buffer): AsyncGenerator<Buffer> {
  yield buffer.subarray(0, 7);
  yield buffer.subarray(7, 100_000);
  yield buffer.subarray(100_000);
}

describe('the key and the recovery code', () => {
  it('turns a key into a code of 14 groups and back, tolerating case and spaces', () => {
    const key = generateKey();
    const code = formatRecoveryCode(key);
    expect(code).toMatch(/^([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/);
    expect(parseRecoveryCode(code).equals(key)).toBe(true);
    expect(parseRecoveryCode(code.toLowerCase().replaceAll('-', ' ')).equals(key)).toBe(true);
  });

  it('notices a typo, a short code and foreign characters', () => {
    const code = formatRecoveryCode(generateKey());
    const flipped = `${code.startsWith('A') ? 'B' : 'A'}${code.slice(1)}`;
    expect(() => parseRecoveryCode(flipped)).toThrow(/ошибка/);
    expect(() => parseRecoveryCode(code.slice(0, 40))).toThrow(/56 знаков/);
    expect(() => parseRecoveryCode('hello')).toThrow(CryptError);
  });

  it('never overwrites an existing key file', async () => {
    const dir = await makeTempDir('fd-key-');
    try {
      const file = path.join(dir, 'secrets', 'backup.key');
      const key = generateKey();
      await writeNewKeyFile(file, key);
      expect((await readKeyFile(file)).equals(key)).toBe(true);
      await expect(writeNewKeyFile(file, generateKey())).rejects.toThrow(/уже существует/);
      expect((await readKeyFile(file)).equals(key)).toBe(true);
      await fsp.writeFile(file, 'not a key');
      await expect(readKeyFile(file)).rejects.toThrow(/повреждён/);
      await expect(readKeyFile(path.join(dir, 'none.key'))).rejects.toThrow(/не найден/);
    } finally {
      await removeDir(dir);
    }
  });
});

describe('the encrypted container', () => {
  const key = generateKey();
  const plain = Buffer.concat([Buffer.from('SECRET-MARKER-123 '), Buffer.alloc(CHUNK_BYTES * 2 + 500, 7)]);

  it('round-trips data of several chunks, however the pieces are cut, and hides the content', async () => {
    const encrypted = await collect(encryptStream(key, once(plain)));
    expect(encrypted.includes(Buffer.from('SECRET-MARKER-123'))).toBe(false);
    expect((await collect(decryptStream(key, pieces(encrypted)))).equals(plain)).toBe(true);
    // empty data and an exact multiple of the chunk size both work
    expect(
      (await collect(decryptStream(key, once(await collect(encryptStream(key, once(Buffer.alloc(0))))))))
        .length,
    ).toBe(0);
    const exact = Buffer.alloc(CHUNK_BYTES * 2, 9);
    expect(
      (await collect(decryptStream(key, once(await collect(encryptStream(key, once(exact))))))).equals(exact),
    ).toBe(true);
  });

  it('makes a different file every time (fresh salt and nonce)', async () => {
    const a = await collect(encryptStream(key, once(plain)));
    const b = await collect(encryptStream(key, once(plain)));
    expect(a.equals(b)).toBe(false);
  });

  it('refuses another key with a message that says so', async () => {
    const encrypted = await collect(encryptStream(key, once(plain)));
    await expect(collect(decryptStream(generateKey(), once(encrypted)))).rejects.toThrow(/другим ключом/);
  });

  it('refuses a damaged byte, a cut-off file, appended data and a file that is not ours', async () => {
    const encrypted = await collect(encryptStream(key, once(plain)));
    const damaged = Buffer.from(encrypted);
    damaged.writeUInt8(
      (damaged.readUInt8(Math.floor(damaged.length / 2)) ^ 1) & 255,
      Math.floor(damaged.length / 2),
    );
    await expect(collect(decryptStream(key, once(damaged)))).rejects.toThrow(/повреждён или изменён/);
    await expect(
      collect(decryptStream(key, once(encrypted.subarray(0, encrypted.length - 20)))),
    ).rejects.toThrow(CryptError);
    // cutting exactly at a chunk boundary must not look like a complete file
    const firstChunkEnd = 33 + 5 + CHUNK_BYTES + 16;
    await expect(collect(decryptStream(key, once(encrypted.subarray(0, firstChunkEnd))))).rejects.toThrow(
      /обрывается/,
    );
    await expect(
      collect(decryptStream(key, once(Buffer.concat([encrypted, Buffer.from('x')])))),
    ).rejects.toThrow(/лишние/);
    await expect(
      collect(decryptStream(key, once(Buffer.from('hello world, not a backup at all!!')))),
    ).rejects.toThrow(/не зашифрованная копия/);
  });

  it('refuses chunks that were swapped', async () => {
    const encrypted = await collect(encryptStream(key, once(plain)));
    const chunk = 5 + CHUNK_BYTES + 16;
    const first = encrypted.subarray(33, 33 + chunk);
    const second = encrypted.subarray(33 + chunk, 33 + 2 * chunk);
    const swapped = Buffer.concat([
      encrypted.subarray(0, 33),
      second,
      first,
      encrypted.subarray(33 + 2 * chunk),
    ]);
    await expect(collect(decryptStream(key, once(swapped)))).rejects.toThrow(/повреждён или изменён/);
  });
});

describe('the archive', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('fd-arc-');
  });
  afterEach(() => removeDir(dir));

  it('carries a folder with nested names, an empty file and a big file', async () => {
    const src = path.join(dir, 'src');
    await fsp.mkdir(path.join(src, 'data', 'вложенная папка'), { recursive: true });
    await fsp.writeFile(path.join(src, 'manifest.json'), '{"a":1}');
    await fsp.writeFile(path.join(src, 'data', 'users.json'), '[]');
    await fsp.writeFile(path.join(src, 'data', 'вложенная папка', 'файл.txt'), 'привет');
    await fsp.writeFile(path.join(src, 'empty'), '');
    const big = Buffer.alloc(CHUNK_BYTES * 2 + 123, 5);
    await fsp.writeFile(path.join(src, 'big.bin'), big);
    const dest = path.join(dir, 'dest');
    const result = await unpackTree(packTree(src), dest);
    expect(result.files).toBe(5);
    expect((await fsp.readFile(path.join(dest, 'big.bin'))).equals(big)).toBe(true);
    expect(await fsp.readFile(path.join(dest, 'data', 'вложенная папка', 'файл.txt'), 'utf8')).toBe('привет');
    // reading without writing counts the same
    expect(await unpackTree(packTree(src), null)).toEqual({ files: 5, bytes: result.bytes });
  });

  const entry = (name: string, body = 'x') => {
    const nameBytes = Buffer.from(name);
    const head = Buffer.alloc(2);
    head.writeUInt16BE(nameBytes.length);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(body.length));
    return Buffer.concat([head, nameBytes, size, Buffer.from(body)]);
  };
  const end = Buffer.from([0, 0]);

  it('refuses paths that leave the folder, absolute paths, duplicates and cut-off archives', async () => {
    for (const bad of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/Windows/x', 'a\\b', 'con.txt']) {
      await expect(unpackTree(once(Buffer.concat([entry(bad), end])), path.join(dir, 'd1'))).rejects.toThrow(
        /Небезопасный путь/,
      );
    }
    await expect(
      unpackTree(once(Buffer.concat([entry('a.txt'), entry('A.TXT'), end])), path.join(dir, 'd2')),
    ).rejects.toThrow(/Повторяющийся/);
    await expect(
      unpackTree(once(Buffer.concat([entry('a.txt', 'abc').subarray(0, 14)])), path.join(dir, 'd3')),
    ).rejects.toThrow(CryptError);
    await expect(unpackTree(once(entry('a.txt')), path.join(dir, 'd4'))).rejects.toThrow(
      /нет признака конца/,
    );
    expect(await fsp.stat(path.join(dir, 'evil.txt')).catch(() => null)).toBeNull();
  });
});

describe('the encrypted copy for outside the house', () => {
  let base: string;
  let clock: FakeClock;
  let dataDir: string;
  let rootA: string;
  let offsiteDir: string;
  let tempDir: string;
  let keyFile: string;
  const GIT = 'git';

  const settings = (extra: Partial<BackupSettings> = {}): BackupSettings => ({
    dataDir,
    targets: [rootA],
    keep: 14,
    repoDir: null,
    extraFiles: [],
    gitExe: GIT,
    offsite: { dir: offsiteDir, keyFile, keep: 2, everyDays: 7 },
    ...extra,
  });
  const deps = (free = 500 * 1024 ** 3): BackupDeps => ({
    clock,
    appVersion: '9.9.9',
    listVolumes: async () => [],
    statfs: async () => ({ freeBytes: free, totalBytes: 1000 * 1024 ** 3 }),
    tailscaleServe: async () => ({}),
    tempDir,
    systemDrive: path.parse(base).root.slice(0, 2),
  });
  const offsiteSettings = () => {
    const value = settings().offsite;
    if (!value) throw new Error('offsite settings expected');
    return value;
  };
  const offsiteDeps = () => ({
    clock,
    statfs: async () => ({ freeBytes: 500 * 1024 ** 3 }),
    dataDir,
    gitExe: GIT,
    tempDir,
  });

  beforeEach(async () => {
    base = await makeTempDir('fd-offsite-');
    clock = createFakeClock(NOW);
    dataDir = path.join(base, 'data');
    rootA = path.join(base, 'backups-a');
    offsiteDir = path.join(base, 'offsite');
    tempDir = path.join(base, 'tmp');
    keyFile = path.join(base, 'secrets', 'backup.key');
    await fsp.mkdir(tempDir, { recursive: true });
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(
      path.join(dataDir, 'users.json'),
      '{"users":[{"username":"u","note":"PRIVATE-MARKER"}]}',
    );
    await fsp.writeFile(path.join(dataDir, 'services.json'), '{"services":[]}');
  });
  afterEach(() => removeDir(base));

  const newestSnapshot = async () => {
    const [newest] = await listSnapshots(rootA);
    if (!newest) throw new Error('no snapshot');
    return newest.dir;
  };

  it('packs the newest copy, checks it, restores it into a new folder and compares it with the manifest', async () => {
    const key = generateKey();
    await writeNewKeyFile(keyFile, key);
    expect((await runBackup(settings({ offsite: null }), deps())).ok).toBe(true);
    const snapshot = await newestSnapshot();
    const pack = await packOffsite(snapshot, offsiteSettings(), key, offsiteDeps());
    expect(pack.existed).toBe(false);
    expect(path.basename(pack.file)).toMatch(/^family-offsite-\d{8}-\d{6}\.fsbk$/);
    const bytes = await fsp.readFile(pack.file);
    expect(bytes.includes(Buffer.from('PRIVATE-MARKER'))).toBe(false);
    expect((await verifyOffsiteFile(pack.file, key)).files).toBe(pack.files);

    const dest = path.join(base, 'restored');
    const restored = await restoreOffsite(pack.file, key, dest, offsiteDeps());
    expect(restored.files).toBe(pack.files);
    expect(await fsp.readFile(path.join(dest, 'data', 'users.json'), 'utf8')).toContain('PRIVATE-MARKER');
    // a second pack of the same copy writes nothing new
    expect((await packOffsite(snapshot, offsiteSettings(), key, offsiteDeps())).existed).toBe(true);
    // the test restore leaves nothing behind
    await testRestoreOffsite(pack.file, key, offsiteDeps());
    expect((await fsp.readdir(tempDir)).filter((name) => name.startsWith('family-offsite-test'))).toEqual([]);
  });

  it('refuses the wrong key, leaves no half-restored folder, and refuses unsafe destinations', async () => {
    const key = generateKey();
    await writeNewKeyFile(keyFile, key);
    await runBackup(settings({ offsite: null }), deps());
    const pack = await packOffsite(await newestSnapshot(), offsiteSettings(), key, offsiteDeps());
    const dest = path.join(base, 'restored');
    await expect(restoreOffsite(pack.file, generateKey(), dest, offsiteDeps())).rejects.toThrow(
      /другим ключом/,
    );
    expect(await fsp.stat(dest).catch(() => null)).toBeNull();
    // damaged file: nothing is left either
    const damaged = Buffer.from(await fsp.readFile(pack.file));
    damaged.writeUInt8(
      (damaged.readUInt8(Math.floor(damaged.length / 2)) ^ 1) & 255,
      Math.floor(damaged.length / 2),
    );
    const copy = path.join(base, 'damaged.fsbk');
    await fsp.writeFile(copy, damaged);
    await expect(restoreOffsite(copy, key, dest, offsiteDeps())).rejects.toThrow(CryptError);
    expect(await fsp.stat(dest).catch(() => null)).toBeNull();
    // never into the live data folder, never into a folder with something in it
    await expect(restoreOffsite(pack.file, key, path.join(dataDir, 'inside'), offsiteDeps())).rejects.toThrow(
      /рабочую папку/,
    );
    await fsp.mkdir(path.join(base, 'busy'));
    await fsp.writeFile(path.join(base, 'busy', 'a.txt'), 'mine');
    await expect(restoreOffsite(pack.file, key, path.join(base, 'busy'), offsiteDeps())).rejects.toThrow(
      /не пуста/,
    );
    expect(await fsp.readFile(path.join(base, 'busy', 'a.txt'), 'utf8')).toBe('mine');
  });

  it('refuses a folder inside the data folder, a full disk, and keeps only the newest files', async () => {
    const key = generateKey();
    await writeNewKeyFile(keyFile, key);
    await runBackup(settings({ offsite: null }), deps());
    const snapshot = await newestSnapshot();
    const inside = { ...offsiteSettings(), dir: path.join(dataDir, 'offsite') };
    await expect(packOffsite(snapshot, inside, key, offsiteDeps())).rejects.toThrow(/папке данных/);
    await expect(
      packOffsite(snapshot, offsiteSettings(), key, {
        ...offsiteDeps(),
        statfs: async () => ({ freeBytes: 10 }),
      }),
    ).rejects.toThrow(/Недостаточно места/);
    expect(await fsp.readdir(offsiteDir).catch(() => [])).toEqual([]);

    for (const name of ['20261001-010000', '20261002-010000', '20261003-010000']) {
      await fsp.mkdir(offsiteDir, { recursive: true });
      await fsp.writeFile(path.join(offsiteDir, `family-offsite-${name}.fsbk`), 'x');
    }
    await fsp.writeFile(path.join(offsiteDir, 'notes.txt'), 'not ours');
    const pruned = await pruneOffsite(offsiteDir, 2, clock);
    expect(pruned.removed).toEqual(['family-offsite-20261001-010000.fsbk']);
    expect((await listOffsite(offsiteDir)).map((entry) => entry.name)).toEqual([
      'family-offsite-20261003-010000.fsbk',
      'family-offsite-20261002-010000.fsbk',
    ]);
    expect(await fsp.readFile(path.join(offsiteDir, 'notes.txt'), 'utf8')).toBe('not ours');
  });

  it('is made by the daily run only when due, never blocks the local copies, and says why it failed', async () => {
    // no key yet: the local copy is fine, the encrypted one is a remark with the way out
    const first = await runBackup(settings(), deps());
    expect(first.ok).toBe(true);
    const failedEntry = first.targets.find(
      (target) => target.optional && target.name.startsWith('Зашифрованная'),
    );
    expect(failedEntry).toMatchObject({ ok: false });
    expect(failedEntry?.error).toMatch(/Ключ шифрования не найден.*init-key/);
    expect(first.warnings.join('\n')).toMatch(/Ключ шифрования/);

    await writeNewKeyFile(keyFile, generateKey());
    clock.advance(60_000);
    const second = await runBackup(settings(), deps());
    expect(second.ok).toBe(true);
    expect(second.targets.find((target) => target.name.startsWith('Зашифрованная'))).toMatchObject({
      ok: true,
    });
    expect(await listOffsite(offsiteDir)).toHaveLength(1);

    clock.advance(24 * 60 * 60 * 1000); // one day later: not due
    const third = await runBackup(settings(), deps());
    expect(third.targets.some((target) => target.name.startsWith('Зашифрованная'))).toBe(false);
    expect(await listOffsite(offsiteDir)).toHaveLength(1);

    clock.advance(8 * 24 * 60 * 60 * 1000); // a week and more: due again
    await runBackup(settings(), deps());
    expect(await listOffsite(offsiteDir)).toHaveLength(2);
  });

  it('decides «due» from the newest file and reports a missing key without throwing', async () => {
    await runBackup(settings({ offsite: null }), deps());
    const outcome = await runOffsiteIfDue(await newestSnapshot(), offsiteSettings(), offsiteDeps());
    expect(outcome).toMatchObject({ ran: true, ok: false });
    expect(outcome.message).toMatch(/Ключ шифрования не найден/);
  });

  it('shows on the status page where the copies are, the room left, and what to do about the copy outside', async () => {
    await runBackup(settings({ offsite: null }), deps(2 * 1024 ** 3));
    // room is tight when less than a gigabyte (or two copies) is left
    await runBackup(settings({ offsite: null }), deps(300 * 1024 ** 2));
    let info = await readBackupStatus(dataDir, clock);
    expect(info.targets?.[0]).toMatchObject({ ok: true, snapshots: 2 });
    expect(info.notes?.join('\n')).toMatch(/осталось .*места хватит ненадолго/);
    expect(info.offsite).toMatchObject({ state: 'not_configured' });
    expect(info.notes?.join('\n')).toMatch(/вне дома нет/);

    await writeNewKeyFile(keyFile, generateKey());
    clock.advance(60_000);
    await runBackup(settings(), deps());
    info = await readBackupStatus(dataDir, clock);
    expect(info.offsite).toMatchObject({ state: 'ok', tested: false });
    expect(info.offsite?.message).toMatch(/целостность проверена/);

    // a copy older than three weeks is called out of date
    clock.advance(25 * 24 * 60 * 60 * 1000);
    info = await readBackupStatus(dataDir, clock);
    expect(info.offsite?.state).toBe('stale');
  });

  it('keeps the older copies when a disk cannot take the next one', async () => {
    await runBackup(settings({ offsite: null, keep: 1 }), deps());
    const before = (await listSnapshots(rootA)).map((entry) => entry.name);
    clock.advance(60_000);
    const full = await runBackup(settings({ offsite: null, keep: 1 }), deps(1024));
    expect(full.ok).toBe(false);
    expect(full.targets[0]?.error).toMatch(/Недостаточно места/);
    expect((await listSnapshots(rootA)).map((entry) => entry.name)).toEqual(before);
    const status = JSON.parse(await fsp.readFile(path.join(dataDir, BACKUP_STATUS_FILE), 'utf8'));
    expect(status.lastResult).toBe('failed');
    expect(status.lastSuccessAt).not.toBeNull();
  });
});
