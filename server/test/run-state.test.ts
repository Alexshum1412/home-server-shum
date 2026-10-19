import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clockTime, createRunState } from '../src/system/run-state.ts';
import { createFakeClock, makeTempDir, removeDir } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('fd-run-');
});
afterEach(async () => {
  await removeDir(dir);
});

describe('did the previous run of the portal end cleanly', () => {
  it('knows nothing at the very first start', async () => {
    const clock = createFakeClock();
    const state = createRunState({ dataDir: dir, clock, pid: 11 });
    const { previous, startedAt } = await state.begin();
    expect(previous).toEqual({ how: 'unknown', at: null });
    expect(startedAt).toBe(clock().toISOString());
    expect(JSON.parse(await readFile(path.join(dir, 'run-state.json'), 'utf8'))).toMatchObject({
      state: 'running',
      pid: 11,
    });
  });

  it('calls a stop on purpose clean, so a normal restart is never an alarm', async () => {
    const clock = createFakeClock();
    const first = createRunState({ dataDir: dir, clock });
    await first.begin();
    clock.advance(60_000);
    await first.end();
    const second = createRunState({ dataDir: dir, clock });
    const { previous } = await second.begin();
    expect(previous.how).toBe('clean');
    expect(previous.at).toBe(clock().toISOString());
  });

  it('calls a run that was cut off crashed, and says when it was last seen alive', async () => {
    const clock = createFakeClock('2026-10-16T10:00:00.000Z');
    const first = createRunState({ dataDir: dir, clock });
    await first.begin();
    clock.advance(60_000);
    await first.heartbeat();
    clock.advance(60_000);
    await first.heartbeat();
    const lastAlive = clock().toISOString();
    clock.advance(3 * 3600_000); // power was off
    const second = createRunState({ dataDir: dir, clock });
    const { previous } = await second.begin();
    expect(previous).toEqual({ how: 'crashed', at: lastAlive });
    // The new run is marked as running: asking again right away would say crashed once more,
    // which is why the portal reads the record exactly once, at its start.
    await second.end();
    expect((await createRunState({ dataDir: dir, clock }).begin()).previous.how).toBe('clean');
  });

  it('does not write a heartbeat after the run was ended', async () => {
    const clock = createFakeClock();
    const state = createRunState({ dataDir: dir, clock });
    await state.begin();
    await state.end();
    clock.advance(60_000);
    await state.heartbeat();
    expect(JSON.parse(await readFile(path.join(dir, 'run-state.json'), 'utf8')).state).toBe('stopped');
  });

  it('treats an unreadable or foreign file as no record', async () => {
    await writeFile(path.join(dir, 'run-state.json'), '{ not json');
    expect((await createRunState({ dataDir: dir, clock: createFakeClock() }).begin()).previous.how).toBe(
      'unknown',
    );
    await writeFile(path.join(dir, 'run-state.json'), JSON.stringify({ state: 'weird' }));
    expect((await createRunState({ dataDir: dir, clock: createFakeClock() }).begin()).previous.how).toBe(
      'unknown',
    );
  });

  it('writes the time as hours and minutes', () => {
    expect(clockTime('2026-10-16T10:07:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
  });
});
