import { describe, expect, it } from 'vitest';
import { explainShutdown, findShutdownReason, parseEvents } from '../src/system/shutdown-reason.ts';

const event = (id: number, provider: string, at: string, data: Record<string, string> = {}) =>
  `<Event xmlns='x'><System><Provider Name='${provider}'/><EventID>${id}</EventID><TimeCreated SystemTime='${at}'/></System><EventData>${Object.entries(
    data,
  )
    .map(([name, value]) => `<Data Name='${name}'>${value}</Data>`)
    .join('')}</EventData></Event>`;

const previousAt = new Date('2026-11-03T03:10:00Z');
const bootedAt = new Date('2026-11-03T03:20:00Z');

describe('why the server came back by itself', () => {
  it('reads events from the xml of the event log', () => {
    const events = parseEvents(
      event(41, 'Microsoft-Windows-Kernel-Power', '2026-11-03T03:20:05Z', {
        BugcheckCode: '0',
        PowerButtonTimestamp: '0',
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 41, data: { BugcheckCode: '0' } });
  });

  it('a sudden loss of power', () => {
    const text = explainShutdown(
      parseEvents(
        event(41, 'Microsoft-Windows-Kernel-Power', '2026-11-03T03:20:05Z', {
          BugcheckCode: '0',
          PowerButtonTimestamp: '0',
        }),
      ),
      { previousAt, bootedAt },
    );
    expect(text).toContain('пропало питание');
  });

  it('a blue screen names its code', () => {
    const text = explainShutdown(
      parseEvents(
        event(41, 'Microsoft-Windows-Kernel-Power', '2026-11-03T03:20:05Z', { BugcheckCode: '292' }),
      ),
      { previousAt, bootedAt },
    );
    expect(text).toContain('синим экраном');
    expect(text).toContain('292');
  });

  it('a planned restart is said to be no breakdown', () => {
    const text = explainShutdown(
      parseEvents(
        event(1074, 'User32', '2026-11-03T03:09:00Z', {
          param1: 'C:\\Windows\\System32\\svchost.exe',
          param3: 'Обновление',
          param5: 'restart',
        }),
      ),
      { previousAt, bootedAt },
    );
    expect(text).toContain('svchost.exe');
    expect(text).toContain('Это не поломка');
  });

  it('a hardware error is named as such', () => {
    const text = explainShutdown(
      parseEvents(event(1, 'Microsoft-Windows-WHEA-Logger', '2026-11-03T03:10:30Z')),
      { previousAt, bootedAt },
    );
    expect(text).toContain('аппаратную ошибку');
  });

  it('when only the portal stopped and the computer kept running, it says so', () => {
    const text = explainShutdown([], { previousAt, bootedAt: new Date('2026-11-01T10:00:00Z') });
    expect(text).toContain('Компьютер не перезагружался');
  });

  it('an empty log is not made into a reason', () => {
    expect(explainShutdown([], { previousAt, bootedAt })).toContain('не записала причину');
  });

  it('never throws: an unreadable log is reported as such', async () => {
    const text = await findShutdownReason({
      previousAt,
      now: bootedAt,
      bootedAt,
      platform: 'win32',
      exec: async () => {
        throw new Error('no wevtutil');
      },
    });
    expect(text).toContain('не удалось');
  });
});
