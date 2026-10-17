import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootTimeMs, parseCommand, pipeNameFor, runSupervisor, sendCommand } from '../src/supervisor/main.ts';
import { type AppSpec, ManagedApp, type ManagedOptions, rotateLog } from '../src/supervisor/managed.ts';
import { FIXTURES_DIR, makeTempDir, removeDir } from './helpers.ts';

const FAKE = path.join(FIXTURES_DIR, 'fake-app.mjs');
let dir: string;
let apps: ManagedApp[];
let logs: string[];

beforeEach(async () => {
  dir = await makeTempDir('fd-sup-');
  apps = [];
  logs = [];
});

afterEach(async () => {
  for (const app of apps) await app.stop();
  await removeDir(dir);
});

function spec(mode: string, extra: Partial<AppSpec> = {}): AppSpec {
  return {
    name: 'fake',
    title: 'Тест',
    command: process.execPath,
    args: [FAKE, mode, '150'],
    cwd: dir,
    ipc: true,
    stopTimeoutMs: 3000,
    stdoutLog: path.join(dir, 'logs', 'fake.out.log'),
    stderrLog: path.join(dir, 'logs', 'fake.err.log'),
    ...extra,
  };
}

function managed(s: AppSpec, extra: Partial<ManagedOptions> = {}): ManagedApp {
  const app = new ManagedApp(s, {
    log: (m) => logs.push(m),
    onChange: () => undefined,
    backoffBaseMs: 50,
    backoffMaxMs: 200,
    ...extra,
  });
  apps.push(app);
  return app;
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ManagedApp', { timeout: 30_000 }, () => {
  it('restarts a crashing program with back-off and counts the restarts', async () => {
    const app = managed(spec('crash'));
    await app.start();
    expect(app.snapshot().state).toBe('running');
    await until(() => app.snapshot().restarts >= 2);
    expect(app.snapshot().lastExit?.code).toBe(3);
    expect(logs.join('\n')).toMatch(/завершился с кодом 3; перезапуск через/);
    const out = await readFile(spec('crash').stdoutLog, 'utf8');
    expect(out.match(/fake-app crash/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('stops cleanly over IPC and does not restart', async () => {
    const app = managed(spec('run'));
    await app.start();
    expect(app.snapshot().pid).toBeGreaterThan(0);
    await app.stop();
    expect(app.snapshot().state).toBe('stopped');
    expect(app.snapshot().lastExit?.code).toBe(0);
    expect(await readFile(spec('run').stdoutLog, 'utf8')).toContain('clean shutdown');
    await new Promise((r) => setTimeout(r, 300));
    expect(app.snapshot().state).toBe('stopped');
  });

  it('kills a program that ignores the stop request after the timeout', async () => {
    const app = managed(spec('stubborn', { stopTimeoutMs: 500 }));
    await app.start();
    await app.stop();
    expect(app.snapshot().state).toBe('stopped');
    expect(logs.join('\n')).toMatch(/принудительно/);
  });

  it('does not start a second copy when the health URL already answers', async () => {
    const fakeFetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    const app = managed(spec('run', { healthUrl: 'http://127.0.0.1:9/health' }), {
      fetch: fakeFetch,
      externalRecheckMs: 60_000,
    });
    await app.start();
    expect(app.snapshot().state).toBe('external');
    expect(app.snapshot().pid).toBeNull();
  });

  it('restarts a hung program whose health check keeps failing', async () => {
    let calls = 0;
    // Every check fails: the program is started, then counted as hung and restarted.
    const fakeFetch = (async () => {
      calls += 1;
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const app = managed(spec('run', { healthUrl: 'http://127.0.0.1:9/health', startupGraceMs: 0 }), {
      fetch: fakeFetch,
      healthIntervalMs: 50,
      healthFailuresToRestart: 2,
    });
    await app.start();
    const firstPid = app.snapshot().pid;
    await until(() => {
      const s = app.snapshot();
      return s.restarts >= 1 && s.pid !== null && s.pid !== firstPid;
    });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(logs.join('\n')).toMatch(/не отвечает 2 проверки подряд/);
  });

  it('rotates a log that grew too big', async () => {
    const file = path.join(dir, 'big.log');
    await writeFile(file, 'x'.repeat(100));
    await rotateLog(file, 50);
    expect(await readFile(`${file}.1`, 'utf8')).toHaveLength(100);
  });
});

describe('runSupervisor', { timeout: 30_000 }, () => {
  const dirs = () => ({ dataDir: dir, logDir: path.join(dir, 'logs'), runDir: path.join(dir, 'run') });

  it('runs one instance per data dir and answers control commands', async () => {
    const pipe = pipeNameFor(dir);
    const sup = await runSupervisor({
      ...dirs(),
      exitProcess: false,
      apps: (hooks) => {
        const app = new ManagedApp(spec('run'), { ...hooks, backoffBaseMs: 50 });
        apps.push(app);
        return [app];
      },
    });
    expect(sup).not.toBeNull();
    // A second supervisor on the same data dir gives way at once.
    expect(await runSupervisor({ ...dirs(), apps: [], exitProcess: false })).toBeNull();

    const status = (await sendCommand(pipe, { cmd: 'status' })) as {
      ok: boolean;
      state: { apps: Array<{ state: string; pid: number }> };
    };
    expect(status.ok).toBe(true);
    expect(status.state.apps[0]?.state).toBe('running');
    const before = status.state.apps[0]?.pid;

    const restarted = (await sendCommand(pipe, { cmd: 'restart', app: 'fake' })) as {
      ok: boolean;
      app: { pid: number };
    };
    expect(restarted.ok).toBe(true);
    expect(restarted.app.pid).not.toBe(before);

    const unknown = (await sendCommand(pipe, { cmd: 'restart', app: 'nothing' })) as { ok: boolean };
    expect(unknown.ok).toBe(false);

    const stateFile = JSON.parse(await readFile(path.join(dir, 'run', 'supervisor.json'), 'utf8'));
    expect(stateFile.pipe).toBe(pipe);

    await sendCommand(pipe, { cmd: 'shutdown' });
    await sup?.done;
    expect(apps[0]?.snapshot().state).toBe('stopped');
    // Stopped on purpose: a watchdog start right after gives way until the next boot.
    expect(await runSupervisor({ ...dirs(), apps: [], exitProcess: false })).toBeNull();
    expect(await readFile(path.join(dir, 'logs', 'supervisor.log'), 'utf8')).toContain(
      'Супервизор остановлен',
    );
  });

  it('forgets a stop request from before the last boot', async () => {
    const { runDir } = dirs();
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, 'supervisor-stopped.json'),
      JSON.stringify({ at: new Date(bootTimeMs() - 3_600_000).toISOString() }),
    );
    const sup = await runSupervisor({ ...dirs(), apps: [], exitProcess: false });
    expect(sup).not.toBeNull();
    await sup?.shutdown('test');
  });

  it('accepts only known commands with a simple app name', () => {
    expect(parseCommand(['status'])).toEqual({ cmd: 'status' });
    expect(parseCommand(['restart', 'jellyfin'])).toEqual({ cmd: 'restart', app: 'jellyfin' });
    expect(parseCommand(['restart', '..\\x'])).toBeNull();
    expect(parseCommand(['exec', 'calc'])).toBeNull();
    expect(parseCommand([])).toBeNull();
  });
});
