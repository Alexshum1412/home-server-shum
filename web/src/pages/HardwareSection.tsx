import { Cpu, MemoryStick, Network, Thermometer } from 'lucide-preact';
import type {
  DiskReliabilityInfo,
  GpuInfo,
  HardwareInfo,
  MetricsHistoryResponse,
  MetricsPoint,
  NetworkAdapterInfo,
} from '../../../shared/api.ts';
import { TableWrap } from '../components/DataTable.tsx';
import { Meter, usageTone } from '../components/Meter.tsx';
import { UpdatedAt } from '../components/RelativeTime.tsx';
import { Metric, Tile } from '../components/Tile.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatBytes, formatNumber, formatPercent, NO_DATA } from '../lib/format.ts';

function footer(collectedAt: string | null) {
  return collectedAt ? <UpdatedAt value={collectedAt} /> : null;
}

function megabits(bytesPerSec: number | null): string {
  if (bytesPerSec === null) return NO_DATA;
  const bits = bytesPerSec * 8;
  if (bits >= 1e6) return `${formatNumber(bits / 1e6, 1)} Мбит/с`;
  return `${formatNumber(bits / 1e3, 0)} Кбит/с`;
}

function CoresTile({ hardware }: { hardware: HardwareInfo }) {
  const cores = hardware.cpuCores;
  const clock = hardware.cpuClock;
  return (
    <Tile title="Ядра процессора" icon={Cpu} level={3} footer={footer(cores.collectedAt)}>
      {cores.value === null ? (
        <p class="tile__text">{cores.reason ?? 'Нет данных'}</p>
      ) : (
        <ul class="core-list">
          {cores.value.map((load, index) => (
            <li key={index} class="core-list__item">
              <span class="core-list__name">Ядро {index + 1}</span>
              <Meter value={load} label={`Загрузка ядра ${index + 1}`} tone={usageTone(load)} />
              <span class="core-list__value">{formatPercent(load)}</span>
            </li>
          ))}
        </ul>
      )}
      <p class="tile__text">
        {clock.value
          ? `Частота: ${formatNumber(clock.value.currentMhz)} МГц из ${formatNumber(clock.value.maxMhz)} МГц (по данным Windows)`
          : `Частота: ${clock.reason ?? NO_DATA}`}
      </p>
    </Tile>
  );
}

function GpuTile({ hardware }: { hardware: HardwareInfo }) {
  const gpu = hardware.gpu;
  const card: GpuInfo | undefined = gpu.value?.[0];
  const memoryPercent =
    card && card.memoryUsedBytes !== null && card.memoryTotalBytes
      ? (card.memoryUsedBytes / card.memoryTotalBytes) * 100
      : null;
  return (
    <Tile title="Видеокарта" icon={MemoryStick} level={3} footer={footer(gpu.collectedAt)}>
      {card ? (
        <>
          <Metric
            value={card.loadPercent === null ? null : formatPercent(card.loadPercent)}
            caption={card.name}
            reason="Драйвер не сообщил загрузку"
          />
          <Meter value={card.loadPercent} label="Загрузка видеокарты" tone={usageTone(card.loadPercent)} />
          <dl class="facts">
            <div class="facts__row">
              <dt>Видеопамять</dt>
              <dd>
                {card.memoryUsedBytes === null || card.memoryTotalBytes === null
                  ? NO_DATA
                  : `${formatBytes(card.memoryUsedBytes, 1)} из ${formatBytes(card.memoryTotalBytes, 1)}`}
              </dd>
            </div>
            <div class="facts__row">
              <dt>Температура</dt>
              <dd>{card.temperatureC === null ? NO_DATA : `${formatNumber(card.temperatureC)} °C`}</dd>
            </div>
            <div class="facts__row">
              <dt>Потребление</dt>
              <dd>{card.powerWatts === null ? NO_DATA : `${formatNumber(card.powerWatts, 1)} Вт`}</dd>
            </div>
            <div class="facts__row">
              <dt>Драйвер</dt>
              <dd>{card.driver ?? NO_DATA}</dd>
            </div>
          </dl>
          <Meter value={memoryPercent} label="Занятая видеопамять" tone={usageTone(memoryPercent)} />
        </>
      ) : (
        <Metric value={null} reason={gpu.reason ?? 'Нет данных о видеокарте'} />
      )}
    </Tile>
  );
}

function TemperatureDetailTile({ hardware }: { hardware: HardwareInfo }) {
  const rows: Array<{ label: string; value: number | null; reason: string | null }> = [
    { label: 'Процессор', value: hardware.cpuTemperatureC.value, reason: hardware.cpuTemperatureC.reason },
    {
      label: 'Видеокарта',
      value: hardware.gpu.value?.[0]?.temperatureC ?? null,
      reason: hardware.gpu.reason ?? 'Драйвер не сообщил температуру',
    },
    {
      label: 'Плата (зона ACPI)',
      value: hardware.boardTemperatureC.value,
      reason: hardware.boardTemperatureC.reason,
    },
  ];
  return (
    <Tile
      title="Температуры"
      icon={Thermometer}
      level={3}
      footer={footer(hardware.cpuTemperatureC.collectedAt)}
    >
      <dl class="facts">
        {rows.map((row) => (
          <div key={row.label} class="facts__row">
            <dt>{row.label}</dt>
            <dd>{row.value === null ? 'Недоступно' : `${formatNumber(row.value, 1)} °C`}</dd>
          </div>
        ))}
      </dl>
      {hardware.cpuTemperatureC.value === null ? (
        <p class="tile__text">{hardware.cpuTemperatureC.reason}</p>
      ) : null}
      <p class="tile__text">Зона платы — не температура процессора: это датчик на материнской плате.</p>
    </Tile>
  );
}

function NetworkTile({ hardware }: { hardware: HardwareInfo }) {
  const network = hardware.network;
  return (
    <Tile title="Сеть" icon={Network} level={3} wide footer={footer(network.collectedAt)}>
      <span id="net-title" class="visually-hidden">
        Сетевые подключения
      </span>
      {network.value === null ? (
        <p class="tile__text">{network.reason ?? 'Нет данных'}</p>
      ) : (
        <TableWrap labelledBy="net-title">
          <table class="table table--stack">
            <thead>
              <tr>
                <th scope="col">Подключение</th>
                <th scope="col">Приём</th>
                <th scope="col">Передача</th>
                <th scope="col">Всего принято</th>
                <th scope="col">Всего отправлено</th>
              </tr>
            </thead>
            <tbody>
              {network.value.map((adapter: NetworkAdapterInfo) => (
                <tr key={adapter.name}>
                  <th scope="row">
                    {adapter.name}
                    <span class="table__sub">
                      {adapter.physical ? 'сетевая карта' : 'туннель или виртуальный адаптер'}
                      {adapter.linkSpeedMbps ? `, ${formatNumber(adapter.linkSpeedMbps)} Мбит/с` : ''}
                    </span>
                  </th>
                  <td class="table__num" data-label="Приём">
                    {megabits(adapter.rxBytesPerSec)}
                  </td>
                  <td class="table__num" data-label="Передача">
                    {megabits(adapter.txBytesPerSec)}
                  </td>
                  <td class="table__num" data-label="Всего принято">
                    {formatBytes(adapter.rxTotalBytes)}
                  </td>
                  <td class="table__num" data-label="Всего отправлено">
                    {formatBytes(adapter.txTotalBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Tile>
  );
}

function DriveCounters({ hardware }: { hardware: HardwareInfo }) {
  const disks = hardware.diskReliability;
  return (
    <section class="page-section">
      <h3 id="smart-title" class="section-title">
        Что диски сообщают о себе
      </h3>
      {disks.value === null ? (
        <p class="tile__text">{disks.reason ?? 'Нет данных'}</p>
      ) : (
        <TableWrap labelledBy="smart-title">
          <table class="table table--stack">
            <thead>
              <tr>
                <th scope="col">Диск</th>
                <th scope="col">Температура</th>
                <th scope="col">Износ</th>
                <th scope="col">Ошибки чтения / записи</th>
                <th scope="col">Проработал</th>
                <th scope="col">Примечание</th>
              </tr>
            </thead>
            <tbody>
              {disks.value.map((disk: DiskReliabilityInfo, index) => (
                <tr key={`${disk.model}-${index}`}>
                  <th scope="row">{disk.model}</th>
                  <td class="table__num" data-label="Температура">
                    {disk.temperatureC === null ? 'Недоступно' : `${disk.temperatureC} °C`}
                  </td>
                  <td class="table__num" data-label="Износ">
                    {disk.wearPercent === null ? 'Недоступно' : `${disk.wearPercent} %`}
                  </td>
                  <td class="table__num" data-label="Ошибки чтения / записи">
                    {disk.readErrors === null && disk.writeErrors === null
                      ? 'Недоступно'
                      : `${disk.readErrors ?? NO_DATA} / ${disk.writeErrors ?? NO_DATA}`}
                  </td>
                  <td class="table__num" data-label="Проработал">
                    {disk.powerOnHours === null ? 'Недоступно' : `${formatNumber(disk.powerOnHours)} ч`}
                  </td>
                  <td class="table__note" data-label="Примечание">
                    {disk.note ?? 'Нет'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <p class="meta">
        Данные самого диска, как их передаёт Windows. Если диск ничего не сообщает, здесь «Недоступно» — это
        не ноль.
      </p>
      {footer(disks.collectedAt)}
    </section>
  );
}

/** A line over the last day; a reading that was not taken leaves a gap instead of a zero. */
function Sparkline(props: {
  title: string;
  points: MetricsPoint[];
  pick: (point: MetricsPoint) => number | null;
  max?: number;
  unit: string;
  format?: (value: number) => string;
}) {
  const W = 320;
  const H = 64;
  const values = props.points.map(props.pick);
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 2) {
    return (
      <figure class="spark">
        <figcaption class="spark__title">{props.title}</figcaption>
        <p class="tile__text">Пока мало данных: график появится через несколько минут.</p>
      </figure>
    );
  }
  const top = props.max ?? Math.max(...known, 1);
  const first = props.points[0]?.t ?? 0;
  const last = props.points.at(-1)?.t ?? first + 1;
  const span = Math.max(1, last - first);
  const segments: string[] = [];
  let current: string[] = [];
  props.points.forEach((point, index) => {
    const value = values[index];
    if (value === null || value === undefined) {
      if (current.length > 0) segments.push(current.join(' '));
      current = [];
      return;
    }
    const x = ((point.t - first) / span) * W;
    const y = H - 2 - (Math.min(value, top) / top) * (H - 4);
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length > 0) segments.push(current.join(' '));
  const show = props.format ?? ((value: number) => `${formatNumber(value, 1)} ${props.unit}`);
  const summary = `${props.title}: за сутки от ${show(Math.min(...known))} до ${show(Math.max(...known))}, сейчас ${show(known.at(-1) ?? 0)}`;
  return (
    <figure class="spark">
      <figcaption class="spark__title">{props.title}</figcaption>
      <svg
        class="spark__svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={summary}
        preserveAspectRatio="none"
      >
        <line class="spark__grid" x1="0" y1={H - 1} x2={W} y2={H - 1} />
        {segments.map((points) =>
          points.includes(' ') ? (
            <polyline key={points} class="spark__line" points={points} />
          ) : (
            <circle
              key={points}
              class="spark__dot"
              cx={points.split(',')[0]}
              cy={points.split(',')[1]}
              r="1.5"
            />
          ),
        )}
      </svg>
      <p class="meta">{summary.slice(props.title.length + 2)}</p>
    </figure>
  );
}

function History() {
  const history = useResource<MetricsHistoryResponse>('/api/system/history');
  const points = history.data?.points ?? [];
  return (
    <section class="page-section">
      <h3 class="section-title">Последние сутки</h3>
      {history.data === null && history.error ? (
        <p class="tile__text">История недоступна: {history.error.message}</p>
      ) : history.data === null ? (
        <p class="tile__text">Загружаем историю…</p>
      ) : (
        <div class="spark-grid">
          <Sparkline title="Процессор, %" points={points} pick={(p) => p.cpu} max={100} unit="%" />
          <Sparkline title="Память, %" points={points} pick={(p) => p.memory} max={100} unit="%" />
          <Sparkline title="Видеокарта, %" points={points} pick={(p) => p.gpu} max={100} unit="%" />
          <Sparkline
            title="Сеть: приём"
            points={points}
            pick={(p) => p.rxBytesPerSec}
            unit=""
            format={(value) => megabits(value)}
          />
          <Sparkline
            title="Сеть: передача"
            points={points}
            pick={(p) => p.txBytesPerSec}
            unit=""
            format={(value) => megabits(value)}
          />
          <Sparkline title="Температура видеокарты, °C" points={points} pick={(p) => p.gpuTemp} unit="°C" />
        </div>
      )}
    </section>
  );
}

/** Administrator only: the details behind the tiles above. */
export function HardwareSection({ hardware }: { hardware: HardwareInfo }) {
  return (
    <>
      <section class="page-section">
        <h2 class="section-title">Оборудование</h2>
        <div class="tile-grid">
          <CoresTile hardware={hardware} />
          <GpuTile hardware={hardware} />
          <TemperatureDetailTile hardware={hardware} />
          <NetworkTile hardware={hardware} />
        </div>
      </section>
      <DriveCounters hardware={hardware} />
      <History />
    </>
  );
}
