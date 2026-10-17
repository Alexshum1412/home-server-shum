import { afterEach, describe, expect, it } from 'vitest';
import type { SystemResponse } from '../../shared/api.ts';
import { type Check, type DoctorInputs, evaluate, exitCodeOf, renderReport } from '../src/system/doctor.ts';
import { createTestApp, removeDir, type TestApp } from './helpers.ts';

let t: TestApp | null = null;
afterEach(async () => {
  if (t) {
    await t.app.close();
    await removeDir(t.dataDir);
  }
  t = null;
});

async function snapshot(): Promise<SystemResponse> {
  t = await createTestApp();
  await t.app.dashboard.collector.collectAll();
  return t.app.dashboard.collector.snapshot('admin');
}

const OK_HTTP = { url: 'http://127.0.0.1:8070/api/health', ok: true, status: 200, detail: null };
const HOST = {
  tasks: [{ name: 'FamilyServer', state: 'Running', lastResult: 0 }],
  firewall: [
    { name: 'Domain', enabled: true },
    { name: 'Private', enabled: true },
  ],
  lanRule: false,
  uacEnabled: true,
};

function inputs(system: SystemResponse, extra: Partial<DoctorInputs> = {}): DoctorInputs {
  return {
    system,
    portal: OK_HTTP,
    jellyfin: { ...OK_HTTP, url: 'http://127.0.0.1:8096/health' },
    host: HOST,
    hostError: null,
    lanBind: [],
    portalBoundTo: ['127.0.0.1'],
    ...extra,
  };
}

const level = (checks: Check[], id: string) => checks.find((c) => c.id === id)?.level;

describe('independent diagnosis', () => {
  it('reports a healthy server without raising the alarm', async () => {
    const checks = evaluate(inputs(await snapshot()));
    expect(level(checks, 'portal')).toBe('ok');
    expect(level(checks, 'jellyfin')).toBe('ok');
    expect(level(checks, 'listen')).toBe('ok');
    expect(level(checks, 'firewall')).toBe('ok');
    // A test app has no supervisor; nothing else is wrong.
    expect(checks.filter((c) => c.level === 'error').map((c) => c.id)).toEqual(['supervisor']);
  });

  it('shows what is down and how to bring it back, in words', async () => {
    const checks = evaluate(
      inputs(await snapshot(), {
        portal: { url: OK_HTTP.url, ok: false, status: null, detail: 'ECONNREFUSED' },
        jellyfin: { url: 'http://127.0.0.1:8096/health', ok: false, status: null, detail: 'ECONNREFUSED' },
      }),
    );
    const portal = checks.find((c) => c.id === 'portal');
    expect(portal?.level).toBe('error');
    expect(portal?.text).toContain('scripts\\start.cmd');
    const jellyfin = checks.find((c) => c.id === 'jellyfin');
    expect(jellyfin?.level).toBe('error');
    expect(jellyfin?.text).toContain('Запасной просмотр');
    expect(exitCodeOf(checks)).toBe(2);
  });

  it('warns about Windows settings that weaken protection and about listening on foreign addresses', async () => {
    const system = await snapshot();
    const weak = evaluate(
      inputs(system, {
        host: { ...HOST, firewall: [{ name: 'Private', enabled: false }], uacEnabled: false },
        portalBoundTo: ['127.0.0.1', '0.0.0.0'],
      }),
    );
    expect(level(weak, 'firewall')).toBe('warn');
    expect(level(weak, 'uac')).toBe('warn');
    expect(level(weak, 'listen')).toBe('error');
  });

  it('accepts the configured home-network address and asks for the firewall rule', async () => {
    const system = await snapshot();
    const checks = evaluate(
      inputs(system, { lanBind: ['192.168.1.252'], portalBoundTo: ['127.0.0.1', '192.168.1.252'] }),
    );
    expect(level(checks, 'listen')).toBe('ok');
    expect(level(checks, 'lan')).toBe('warn');
    const withRule = evaluate(
      inputs(system, {
        lanBind: ['192.168.1.252'],
        portalBoundTo: ['127.0.0.1', '192.168.1.252'],
        host: { ...HOST, lanRule: true },
      }),
    );
    expect(level(withRule, 'lan')).toBe('ok');
  });

  it('does not invent facts when Windows cannot be read', async () => {
    const checks = evaluate(inputs(await snapshot(), { host: null, hostError: 'PowerShell не найден' }));
    expect(level(checks, 'host')).toBe('unknown');
    expect(level(checks, 'firewall')).toBeUndefined();
  });

  it('renders a readable report and exit codes', async () => {
    const checks = evaluate(inputs(await snapshot()));
    const report = renderReport(checks, new Date('2026-10-17T12:00:00Z'));
    expect(report).toContain('Диагностика семейного сервера');
    expect(report).toMatch(/\[ОК\] Портал/);
    expect(exitCodeOf([{ id: 'a', level: 'ok', title: 't', text: 'x' }])).toBe(0);
    expect(exitCodeOf([{ id: 'a', level: 'warn', title: 't', text: 'x' }])).toBe(1);
    expect(exitCodeOf([{ id: 'a', level: 'error', title: 't', text: 'x' }])).toBe(2);
  });
});
