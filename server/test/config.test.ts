import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_URL, DEFAULT_TAILSCALE_EXE, loadConfig } from '../src/config.ts';
import { REPO_ROOT } from './helpers.ts';

describe('loadConfig', () => {
  it('uses safe defaults (loopback, port 8070, no demo)', () => {
    const config = loadConfig(
      { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local', SystemDrive: 'C:' },
      'win32',
    );
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8070);
    // The family server root: C:\FamilyServer\data\dashboard (not the user profile).
    expect(config.dataDir).toBe(path.resolve('C:\\FamilyServer\\data\\dashboard'));
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
    expect(config.backupTargets).toEqual(['C:\\FamilyServer\\backups', 'label:reserve\\FamilyServerBackups']);
    expect(config.backupKeep).toBe(14);
    expect(config.backupRepoDir).toBe(path.resolve(REPO_ROOT));
    expect(config.backupExtraFiles).toBeNull();
    expect(config.gitExe).toBe('git');
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.backupTargets)).toBe(true);
  });

  it('puts the data dir and the main-disk backups on the system drive', () => {
    const config = loadConfig({ SystemDrive: 'E:' }, 'win32');
    expect(config.dataDir).toBe(path.resolve('E:\\FamilyServer\\data\\dashboard'));
    expect(config.backupTargets[0]).toBe('E:\\FamilyServer\\backups');
    // No SystemDrive in the environment → C:
    expect(loadConfig({}, 'win32').dataDir).toBe(path.resolve('C:\\FamilyServer\\data\\dashboard'));
  });

  it('falls back to the home directory and "/" outside Windows', () => {
    const config = loadConfig({}, 'linux');
    expect(config.dataDir).toContain('.family-dashboard');
    expect(config.volumes).toEqual(['/']);
    expect(config.backupTargets).toHaveLength(1);
    expect(config.backupTargets[0]).toContain('family-dashboard-backups');
  });

  it('parses backup settings', () => {
    const config = loadConfig(
      {
        BACKUP_TARGETS: ' D:\\Backups ; label:reserve\\Family\\Copies ;',
        BACKUP_KEEP: '30',
        BACKUP_REPO_DIR: 'D:\\code\\dashboard',
        BACKUP_EXTRA_FILES: 'D:\\code\\dashboard\\.env; D:\\secrets\\extra.json',
        GIT_EXE: 'C:\\Program Files\\Git\\cmd\\git.exe',
      },
      'win32',
    );
    expect(config.backupTargets).toEqual(['D:\\Backups', 'label:reserve\\Family\\Copies']);
    expect(config.backupKeep).toBe(30);
    expect(config.backupRepoDir).toBe(path.resolve('D:\\code\\dashboard'));
    expect(config.backupExtraFiles).toEqual(['D:\\code\\dashboard\\.env', 'D:\\secrets\\extra.json']);
    expect(config.gitExe).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(loadConfig({ BACKUP_EXTRA_FILES: 'none' }, 'win32').backupExtraFiles).toEqual([]);
  });

  it('rejects invalid backup settings', () => {
    expect(() => loadConfig({ BACKUP_KEEP: '0' }, 'win32')).toThrow(/BACKUP_KEEP/);
    expect(() => loadConfig({ BACKUP_KEEP: 'many' }, 'win32')).toThrow(/BACKUP_KEEP/);
    expect(() => loadConfig({ BACKUP_TARGETS: 'backups' }, 'win32')).toThrow(/BACKUP_TARGETS/);
    expect(() => loadConfig({ BACKUP_TARGETS: 'label:reserve' }, 'win32')).toThrow(/BACKUP_TARGETS/);
    expect(() => loadConfig({ BACKUP_TARGETS: 'label:reserve\\..\\x' }, 'win32')).toThrow(/BACKUP_TARGETS/);
    expect(() => loadConfig({ BACKUP_TARGETS: ' ; ' }, 'win32')).toThrow(/BACKUP_TARGETS/);
    expect(() => loadConfig({ BACKUP_EXTRA_FILES: 'relative\\.env' }, 'win32')).toThrow(/BACKUP_EXTRA_FILES/);
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
