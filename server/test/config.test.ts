import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_URL, DEFAULT_TAILSCALE_EXE, loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('uses safe defaults (loopback, port 8070, no demo)', () => {
    const config = loadConfig({ LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' }, 'win32');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8070);
    expect(config.dataDir).toBe(path.resolve('C:\\Users\\Test\\AppData\\Local\\FamilyDashboard'));
    expect(config.demo).toBe(false);
    expect(config.logLevel).toBe('info');
    expect(config.serviceCheckIntervalSec).toBe(60);
    expect(config.serviceCheckTimeoutMs).toBe(3000);
    expect(config.volumes).toEqual(['C:\\']);
    expect(config.lowSpacePercent).toBe(10);
    expect(config.printerName).toBeNull();
    expect(config.tailscaleExe).toBe(DEFAULT_TAILSCALE_EXE);
    expect(config.publicUrl).toBe(DEFAULT_PUBLIC_URL);
    expect(config.lanUrl).toBeNull();
    expect(config.cookieSecure).toBe('auto');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('falls back to the home directory and "/" outside Windows', () => {
    const config = loadConfig({}, 'linux');
    expect(config.dataDir).toContain('.family-dashboard');
    expect(config.volumes).toEqual(['/']);
  });

  it('parses explicit values', () => {
    const config = loadConfig(
      {
        HOST: '0.0.0.0',
        PORT: '8099',
        DASHBOARD_DATA_DIR: 'D:\\data',
        DASHBOARD_DEMO: '1',
        LOG_LEVEL: 'WARN',
        SERVICE_CHECK_INTERVAL_SEC: '120',
        SERVICE_CHECK_TIMEOUT_MS: '1500',
        VOLUMES: 'C:\\; D:\\ ;',
        LOW_SPACE_PERCENT: '7.5',
        PRINTER_NAME: 'HP LaserJet',
        PUBLIC_URL: '',
        LAN_URL: 'http://192.168.1.10:8070/',
        COOKIE_SECURE: 'always',
      },
      'win32',
    );
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 8099,
      demo: true,
      logLevel: 'warn',
      serviceCheckIntervalSec: 120,
      serviceCheckTimeoutMs: 1500,
      volumes: ['C:\\', 'D:\\'],
      lowSpacePercent: 7.5,
      printerName: 'HP LaserJet',
      publicUrl: null,
      lanUrl: 'http://192.168.1.10:8070',
      cookieSecure: 'always',
    });
  });

  it('rejects invalid values with a clear error', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ DASHBOARD_DEMO: 'maybe' })).toThrow(/DASHBOARD_DEMO/);
    expect(() => loadConfig({ COOKIE_SECURE: 'sometimes' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ LAN_URL: 'javascript:alert(1)' })).toThrow(/LAN_URL/);
    expect(() => loadConfig({ SERVICE_CHECK_TIMEOUT_MS: '5' })).toThrow(/SERVICE_CHECK_TIMEOUT_MS/);
    expect(() => loadConfig({ VOLUMES: ' ; ' })).toThrow(/VOLUMES/);
  });
});
