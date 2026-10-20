import { Lock, ShieldAlert } from 'lucide-preact';
import { useId, useState } from 'preact/hooks';
import type { NetworkDevice, SafetyResponse } from '../../../shared/extras.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatBytes, formatDateTime } from '../lib/format.ts';
import { useIsAdmin } from '../state.tsx';

const KIND: Record<string, string> = {
  shutdown: 'Выключение',
  program: 'Программа',
  backup: 'Копия',
  disk: 'Диск',
  device: 'Устройство',
  decoy: 'Приманка',
  network: 'Сеть',
  login: 'Вход',
  other: 'Другое',
};

function DeviceRow(props: {
  device: NetworkDevice;
  busy: boolean;
  onSave: (device: NetworkDevice, name: string, known: boolean) => void;
}) {
  const { device } = props;
  const [name, setName] = useState(device.name);
  const id = useId();
  return (
    <tr>
      <td data-label="Адрес">
        {device.ip}
        <span class="table__sub">{device.mac}</span>
      </td>
      <td data-label="Название">
        <label class="visually-hidden" htmlFor={id}>
          Название устройства {device.ip}
        </label>
        <input
          id={id}
          class="field__input"
          maxLength={60}
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </td>
      <td data-label="Состояние">
        {device.online ? 'в сети' : 'давно не видно'}
        <span class="table__sub">последний раз {formatDateTime(device.lastSeen)}</span>
      </td>
      <td data-label="Своё">
        <label class="check">
          <input
            type="checkbox"
            checked={device.known}
            disabled={props.busy}
            onChange={(e) => props.onSave(device, name, e.currentTarget.checked)}
          />
          {device.known ? 'своё' : 'незнакомое'}
        </label>
        <button
          type="button"
          class="button button--quiet"
          disabled={props.busy || name === device.name}
          onClick={() => props.onSave(device, name, device.known)}
        >
          Сохранить название
        </button>
      </td>
    </tr>
  );
}

/** «Безопасность» (administrator): the journal of incidents, the forecast of the disk, devices of the network, decoys. */
export function SafetyPage() {
  const isAdmin = useIsAdmin();
  const toast = useToast();
  const data = useResource<SafetyResponse>(isAdmin ? '/api/admin/safety' : null);
  const [busy, setBusy] = useState(false);

  async function act<T>(path: string, body: unknown, ok: string) {
    setBusy(true);
    try {
      await apiPost<T>(path, body);
      toast.showOk(ok);
      data.reload();
    } catch (error) {
      const failure = toFailure(error);
      toast.showError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) {
    return (
      <div class="page">
        <PageHeader title="Безопасность" icon={ShieldAlert} />
        <EmptyState icon={Lock} title="Раздел доступен только администраторам" />
      </div>
    );
  }
  const d = data.data;
  const unknown = d?.devices.filter((device) => !device.known).length ?? 0;
  return (
    <div class="page">
      <PageHeader
        title="Безопасность"
        icon={ShieldAlert}
        lead="Журнал происшествий, прогноз заполнения диска, устройства домашней сети и файлы-приманки. Только чтение и подсказки: ничего не блокируется само."
      />
      {data.error && !d ? (
        <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />
      ) : null}
      {!d && !data.error ? <Loading label="Загружаем…" /> : null}
      {d ? (
        <>
          <section class="page-section" aria-labelledby="safety-net">
            <h2 id="safety-net" class="section-title">
              Интернет
            </h2>
            <p class="section-lead">
              {d.internet.up === null
                ? 'Ещё не проверяли.'
                : !d.internet.up
                  ? 'У компьютера нет выхода в интернет.'
                  : d.internet.dnsUp === false
                    ? 'Связь есть, но имена сайтов не находятся (DNS).'
                    : 'Интернет и DNS работают.'}
              {d.internet.checkedAt ? ` Проверено ${formatDateTime(d.internet.checkedAt)}.` : ''}
            </p>
          </section>

          <section class="page-section" aria-labelledby="safety-disk">
            <h2 id="safety-disk" class="section-title">
              Прогноз по диску
            </h2>
            {d.forecast.length === 0 ? (
              <p class="section-lead">Данные копятся: прогноз появится примерно через сутки.</p>
            ) : null}
            <ul class="status-list">
              {d.forecast.map((f) => (
                <li key={f.volume} class="status-list__item">
                  <span>
                    <strong>{f.volume}</strong> — свободно {formatBytes(f.freeBytes)}.{' '}
                    {f.daysLeft !== null
                      ? `При нынешней скорости (${formatBytes(f.perDayBytes ?? 0)} в сутки) место закончится примерно через ${f.daysLeft} дн.`
                      : f.perDayBytes !== null
                        ? 'Место убывает медленно: тревоги нет.'
                        : f.points < 12
                          ? 'Пока мало данных для прогноза.'
                          : 'Свободного места не становится меньше.'}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section class="page-section" aria-labelledby="safety-dev">
            <h2 id="safety-dev" class="section-title">
              Устройства в домашней сети {unknown > 0 ? `(незнакомых: ${unknown})` : ''}
            </h2>
            <p class="section-lead">
              Список составлен из того, что этот компьютер видел в сети (таблица соседей Windows). Спящий
              телефон может не показаться. Новое устройство попадает в журнал и приходит вам уведомлением.
              Подпишите свои устройства и отметьте «своё».
            </p>
            <div class="action-row">
              <button
                type="button"
                class="button button--secondary"
                disabled={busy}
                onClick={() =>
                  void act('/api/admin/safety/devices/scan', { active: false }, 'Список обновлён.')
                }
              >
                Обновить список
              </button>
              <button
                type="button"
                class="button button--secondary"
                disabled={busy}
                onClick={() =>
                  void act('/api/admin/safety/devices/scan', { active: true }, 'Домашняя сеть опрошена.')
                }
              >
                Опросить всю домашнюю сеть
              </button>
            </div>
            {d.devices.length === 0 ? (
              <p class="section-lead">Устройств пока не видно. Нажмите «Опросить всю домашнюю сеть».</p>
            ) : (
              <div class="table-wrap">
                <table class="table table--stack">
                  <thead>
                    <tr>
                      <th scope="col">Адрес</th>
                      <th scope="col">Название</th>
                      <th scope="col">Состояние</th>
                      <th scope="col">Своё</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.devices.map((device) => (
                      <DeviceRow
                        key={device.mac}
                        device={device}
                        busy={busy}
                        onSave={(dev, name, known) =>
                          void act(
                            '/api/admin/safety/devices/name',
                            { mac: dev.mac, name, known },
                            'Сохранено.',
                          )
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section class="page-section" aria-labelledby="safety-decoy">
            <h2 id="safety-decoy" class="section-title">
              Файлы-приманки
            </h2>
            <p class="section-lead">
              В общих файлах лежат файлы с заманчивыми названиями («Пароли от всего» и т. п.) и выдуманным
              содержимым. Они никому не нужны: кто их откроет, тот будет замечен, а вам придёт уведомление.
              Настоящих данных в них нет.
            </p>
            {d.decoys.length > 0 ? (
              <ul class="status-list">
                {d.decoys.map((decoy) => (
                  <li key={decoy.path} class="status-list__item">
                    <span>
                      <strong>{decoy.path}</strong> — открывали {decoy.touched} раз
                      {decoy.lastTouchedAt ? `, последний ${formatDateTime(decoy.lastTouchedAt)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div class="action-row">
              <button
                type="button"
                class="button button--secondary"
                disabled={busy}
                onClick={() =>
                  void act('/api/admin/safety/decoys', { action: 'install' }, 'Приманки созданы.')
                }
              >
                Создать приманки
              </button>
              {d.decoys.length > 0 ? (
                <button
                  type="button"
                  class="button button--quiet"
                  disabled={busy}
                  onClick={() =>
                    void act('/api/admin/safety/decoys', { action: 'remove' }, 'Приманки убраны.')
                  }
                >
                  Убрать приманки
                </button>
              ) : null}
            </div>
          </section>

          <section class="page-section" aria-labelledby="safety-log">
            <h2 id="safety-log" class="section-title">
              Журнал происшествий
            </h2>
            {d.incidents.length === 0 ? <p class="section-lead">Пока ничего не записано.</p> : null}
            <ul class="status-list">
              {d.incidents.map((incident) => (
                <li key={incident.id} class="status-list__item">
                  <span>
                    <strong>{incident.title}</strong>{' '}
                    <span class="meta">
                      · {KIND[incident.kind] ?? 'Другое'} · {formatDateTime(incident.at)}
                    </span>
                    {incident.detail ? <span class="meta"> — {incident.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
      <ToastRegion toast={toast} />
    </div>
  );
}
