import type { SystemResponse } from '../../../shared/api.ts';
import type { DiskForecast, FamilyStatusResponse, StatusItem, StatusLevel } from '../../../shared/extras.ts';
import type { InternetState } from './net-check.ts';

const worst = (levels: StatusLevel[]): StatusLevel =>
  levels.includes('bad')
    ? 'bad'
    : levels.includes('warn')
      ? 'warn'
      : levels.includes('unknown')
        ? 'unknown'
        : 'ok';

const ageWords = (iso: string | null, now: Date): string => {
  if (!iso) return 'нет данных';
  const hours = Math.floor((now.getTime() - new Date(iso).getTime()) / 3_600_000);
  return hours < 1
    ? 'меньше часа назад'
    : hours < 36
      ? `${hours} ч назад`
      : `${Math.floor(hours / 24)} дн. назад`;
};

/** «Интернет есть, медиатека работает, копия свежая»: the family's view of the server in a few lines. */
export function buildFamilyStatus(input: {
  system: SystemResponse;
  internet: InternetState;
  forecast: DiskForecast[];
  now: Date;
}): FamilyStatusResponse {
  const { system, internet, forecast, now } = input;
  const items: StatusItem[] = [];

  items.push({ id: 'portal', title: 'Портал', level: 'ok', text: 'работает' });

  if (internet.up === null) {
    items.push({ id: 'internet', title: 'Интернет', level: 'unknown', text: 'ещё не проверяли' });
  } else if (!internet.up) {
    items.push({
      id: 'internet',
      title: 'Интернет',
      level: 'bad',
      text: 'у домашнего компьютера нет выхода в интернет',
    });
  } else if (internet.dnsUp === false) {
    items.push({
      id: 'internet',
      title: 'Интернет',
      level: 'warn',
      text: 'связь есть, но имена сайтов не находятся (DNS)',
    });
  } else {
    items.push({ id: 'internet', title: 'Интернет', level: 'ok', text: 'есть' });
  }

  const programs = system.programs.value ?? [];
  const jellyfin = programs.find((p) => p.name === 'jellyfin');
  items.push(
    jellyfin
      ? {
          id: 'cinema',
          title: 'Кинотеатр',
          level: jellyfin.state === 'running' ? 'ok' : 'bad',
          text:
            jellyfin.state === 'running'
              ? 'работает'
              : 'не работает: администратор уже знает или скоро узнает',
        }
      : { id: 'cinema', title: 'Кинотеатр', level: 'unknown', text: 'нет сведений' },
  );

  const backup = system.backup;
  items.push({
    id: 'backup',
    title: 'Резервная копия',
    level:
      backup.state === 'ok'
        ? 'ok'
        : backup.state === 'unknown'
          ? 'unknown'
          : backup.state === 'stale'
            ? 'warn'
            : 'bad',
    text: backup.state === 'ok' ? `свежая (${ageWords(backup.lastSuccessAt, now)})` : backup.message,
  });

  const low = system.volumes.find((v) => v.lowSpace);
  // Nothing measured yet (the server has only just started): never say «достаточно» without a measurement.
  const measured = system.volumes.some((v) => v.freeBytes !== null);
  const soon = forecast.find((f) => f.daysLeft !== null && f.daysLeft < 30);
  items.push(
    low
      ? { id: 'disk', title: 'Место на диске', level: 'bad', text: `мало места на ${low.path}` }
      : soon
        ? {
            id: 'disk',
            title: 'Место на диске',
            level: 'warn',
            text: `при нынешней скорости закончится примерно через ${soon.daysLeft} дн.`,
          }
        : measured
          ? { id: 'disk', title: 'Место на диске', level: 'ok', text: 'достаточно' }
          : { id: 'disk', title: 'Место на диске', level: 'unknown', text: 'ещё не проверено' },
  );

  const level = worst(items.map((item) => item.level));
  const headline =
    level === 'ok'
      ? 'Всё работает'
      : level === 'warn'
        ? 'Работает, но есть замечания'
        : level === 'bad'
          ? 'Есть неполадки'
          : 'Часть сведений недоступна';
  return { generatedAt: now.toISOString(), level, headline, items };
}
