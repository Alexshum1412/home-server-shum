import { describe, expect, it } from 'vitest';
import { Sha256, sha256OfBlob } from './sha256.ts';

/** The platform's own SHA-256 (Web Crypto, the same in the browser and in Node). */
async function reference(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(size));
  for (let at = 0; at < size; at += 65_536)
    crypto.getRandomValues(out.subarray(at, Math.min(size, at + 65_536)));
  return out;
}

describe('SHA-256 in pieces', () => {
  it('knows the standard test strings', () => {
    expect(new Sha256().digestHex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256().update(new TextEncoder().encode('abc')).digestHex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const long = new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq');
    expect(new Sha256().update(long).digestHex()).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('gives the same answer as the platform for every length around the block sizes, however it is cut', async () => {
    for (const size of [
      0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000, 4096, 100_003,
    ]) {
      const data = randomBytes(size);
      const expected = await reference(data);
      expect(new Sha256().update(data).digestHex(), `one piece of ${size}`).toBe(expected);
      for (const cut of [1, 7, 63, 64, 65, 1000]) {
        const hash = new Sha256();
        for (let at = 0; at < data.length; at += cut) hash.update(data.subarray(at, at + cut));
        expect(hash.digestHex(), `${size} bytes in pieces of ${cut}`).toBe(expected);
      }
    }
  });

  it('hashes a file blob slice by slice and reports progress', async () => {
    const data = randomBytes(9 * 1024 * 1024 + 123);
    const seen: number[] = [];
    const hex = await sha256OfBlob(new Blob([data]), (share) => seen.push(share));
    expect(hex).toBe(await reference(data));
    expect(seen.length).toBe(3);
    expect(seen.at(-1)).toBe(1);
  });

  it('stops when asked', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      sha256OfBlob(new Blob([new Uint8Array(10)]), undefined, controller.signal),
    ).rejects.toThrow();
  });
});
