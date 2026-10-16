import {
  Activity,
  Clock,
  Cpu,
  DatabaseBackup,
  Globe,
  HardDrive,
  MemoryStick,
  Monitor,
  Printer,
  Thermometer,
} from 'lucide-preact';
import type { PhysicalDiskInfo, SystemResponse, VolumeInfo } from '../../../shared/api.ts';
import { AlertList } from '../components/AlertList.tsx';
import { TableWrap } from '../components/DataTable.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { Meter, usageTone } from '../components/Meter.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { RelativeTime, UpdatedAt } from '../components/RelativeTime.tsx';
import { Loading, Skeleton } from '../components/Skeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { Metric, Tile } from '../components/Tile.tsx';
import {
  formatBytes,
  formatBytesPair,
  formatCount,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  NO_DATA,
  pluralRu,
  usedPercent,
} from '../lib/format.ts';
import {
  BACKUP_STATE,
  DISK_HEALTH,
  LOW_SPACE,
  PRINTER_STATE,
  SPACE_OK,
  TAILSCALE_STATE,
  UNKNOWN,
} from '../lib/labels.ts';
import { useData, useIsAdmin } from '../state.tsx';

function CpuTile({ data }: { data: SystemResponse }) {
  const { cpu } = data;
  const usage = cpu.usagePercent.value;
  return (
    <Tile title="Процессор" icon={Cpu} level={3} footer={<UpdatedAt value={cpu.usagePercent.collectedAt} />}>
      <Metric
        value={usage == null ? null : formatPercent(usage)}
        caption="Средняя загрузка за последние секунды"
        reason={cpu.usagePercent.reason}
      />
      <Meter value={usage} label="Загрузка процессора" tone={usageTone(usage)} />
      <p class="tile__text">
        {cpu.model}, {cpu.cores} {pluralRu(cpu.cores, 'ядро', 'ядра', 'ядер')}
      </p>
    </Tile>
  );
}

function MemoryTile({ data }: { data: SystemResponse }) {
  const { memory } = data;
  const used = memory.usedBytes.value;
  const percent = used == null || memory.totalBytes <= 0 ? null : (used / memory.totalBytes) * 100;
  const [usedText, totalText] = formatBytesPair(used, memory.totalBytes);
  return (
    <Tile
      title="Память"
      icon={MemoryStick}
      level={3}
      footer={<UpdatedAt value={memory.usedBytes.collectedAt} />}
    >
      <Metric
        value={used == null ? null : `${usedText} из ${totalText}`}
        caption={percent == null ? undefined : `Занято ${formatPercent(percent)}`}
        reason={memory.usedBytes.reason}
      />
      <Meter value={percent} label="Занятая память" tone={usageTone(percent)} />
    </Tile>
  );
}

function UptimeTile({ data }: { data: SystemResponse }) {
  const uptime = data.server.uptimeSeconds;
  return (
    <Tile title="Время работы" icon={Clock} level={3} footer={<UpdatedAt value={uptime.collectedAt} />}>
      <Metric
        value={uptime.value == null ? null : formatDuration(uptime.value)}
        caption="Компьютер работает без перезагрузки"
        reason={uptime.reason}
      />
      <p class="tile__text">
        Портал запущен <RelativeTime value={data.server.startedAt} />
      </p>
    </Tile>
  );
}

function TemperatureTile({ data }: { data: SystemResponse }) {
  const temperature = data.temperatureC;
  return (
    <Tile
      title="Температура"
      icon={Thermometer}
      level={3}
      footer={<UpdatedAt value={temperature.collectedAt} />}
    >
      <Metric
        value={temperature.value == null ? null : `${formatNumber(temperature.value)} °C`}
        caption={temperature.source}
        reason={temperature.reason ?? 'Датчик температуры недоступен.'}
      />
    </Tile>
  );
}

function VolumeTile({ volume }: { volume: VolumeInfo }) {
  const known = volume.totalBytes != null && volume.freeBytes != null;
  const used = usedPercent(volume.freeBytes, volume.totalBytes);
  const status = known ? (volume.lowSpace ? LOW_SPACE : SPACE_OK) : UNKNOWN;
  const [freeText, totalText] = formatBytesPair(volume.freeBytes, volume.totalBytes);
  return (
    <Tile
      title={`Диск ${volume.path}`}
      icon={HardDrive}
      level={3}
      status={status}
      footer={<UpdatedAt value={volume.collectedAt} />}
    >
      <Metric
        value={known ? `Свободно ${freeText}` : null}
        caption={known ? `из ${totalText}, занято ${formatPercent(used)}` : undefined}
        reason={volume.reason}
      />
      <Meter
        value={used}
        label={`Занятое место на диске ${volume.path}`}
        tone={volume.lowSpace ? 'warn' : 'neutral'}
      />
      {volume.lowSpace ? (
        <p class="tile__text tile__text--warn">
          Места осталось мало. Удалите ненужное или перенесите часть файлов.
        </p>
      ) : null}
    </Tile>
  );
}

function RemoteTile({ data, isAdmin }: { data: SystemResponse; isAdmin: boolean }) {
  const remote = data.tailscale;
  return (
    <Tile
      title="Удалённый доступ"
      icon={Globe}
      level={3}
      status={TAILSCALE_STATE[remote.state]}
      footer={<UpdatedAt value={remote.collectedAt} />}
    >
      <p class="tile__text">
        {remote.state === 'running'
          ? 'Портал открывается с устройств семьи через Tailscale.'
          : (remote.reason ?? 'Из других мест портал сейчас не открыть.')}
      </p>
      {isAdmin ? (
        <dl class="facts">
          <div class="facts__row">
            <dt>Имя в сети</dt>
            <dd class="facts__value--wrap">{remote.dnsName ?? NO_DATA}</dd>
          </div>
          <div class="facts__row">
            <dt>Других устройств в сети</dt>
            <dd>
              {remote.peersOnline == null
                ? NO_DATA
                : formatCount(remote.peersOnline, 'устройство', 'устройства', 'устройств')}
            </dd>
          </div>
          <div class="facts__row">
            <dt>Версия Tailscale</dt>
            <dd>{remote.version ?? NO_DATA}</dd>
          </div>
        </dl>
      ) : null}
    </Tile>
  );
}

function PrinterTile({ data }: { data: SystemResponse }) {
  const { printer } = data;
  return (
    <Tile
      title="Принтер"
      icon={Printer}
      level={3}
      status={PRINTER_STATE[printer.state]}
      footer={<UpdatedAt value={printer.collectedAt} prefix="По данным Windows, обновлено" />}
    >
      <p class="tile__strong">{printer.name ?? 'Принтер не определён'}</p>
      <p class="tile__text">{printer.message}</p>
    </Tile>
  );
}

function BackupTile({ data }: { data: SystemResponse }) {
  const { backup } = data;
  return (
    <Tile
      title="Резервные копии"
      icon={DatabaseBackup}
      level={3}
      status={BACKUP_STATE[backup.state]}
      footer={<UpdatedAt value={data.generatedAt} />}
    >
      <p class="tile__text">{backup.message}</p>
      <dl class="facts">
        <div class="facts__row">
          <dt>Последняя удачная копия</dt>
          <dd>{backup.lastSuccessAt ? formatDateTime(backup.lastSuccessAt) : 'Не было'}</dd>
        </div>
        <div class="facts__row">
          <dt>Восстановление проверено</dt>
          <dd>{backup.restoreTested ? 'Да' : 'Нет'}</dd>
        </div>
      </dl>
    </Tile>
  );
}

function DisksSection({ data }: { data: SystemResponse }) {
  const disks = data.physicalDisks;
  return (
    <section class="page-section">
      <h2 id="disks-title" class="section-title">
        Физические диски
      </h2>
      {disks.value == null ? (
        <p class="tile__text">{disks.reason ?? 'Нет данных о физических дисках.'}</p>
      ) : disks.value.length === 0 ? (
        <p class="tile__text">Windows не сообщила ни об одном диске.</p>
      ) : (
        <TableWrap labelledBy="disks-title">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Модель</th>
                <th scope="col">Объём</th>
                <th scope="col">Тип</th>
                <th scope="col">Состояние</th>
                <th scope="col">Примечание</th>
              </tr>
            </thead>
            <tbody>
              {disks.value.map((disk: PhysicalDiskInfo, index) => (
                <tr key={`${disk.model}-${index}`}>
                  <th scope="row">{disk.model}</th>
                  <td class="table__num">{formatBytes(disk.sizeBytes)}</td>
                  <td>
                    {disk.mediaType}, {disk.busType}
                  </td>
                  <td>
                    <StatusBadge status={DISK_HEALTH[disk.health]} />
                    <span class="table__sub">
                      Windows: {disk.rawHealth || NO_DATA}, {disk.rawOperational || NO_DATA}
                    </span>
                  </td>
                  <td class="table__note">{disk.note ?? 'Нет'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <UpdatedAt value={disks.collectedAt} />
    </section>
  );
}

function ComputerSection({ data }: { data: SystemResponse }) {
  const { server } = data;
  return (
    <section class="page-section">
      <h2 class="section-title">
        <Monitor class="section-title__icon" size={20} aria-hidden="true" />
        Компьютер
      </h2>
      <dl class="facts facts--panel">
        <div class="facts__row">
          <dt>Имя компьютера</dt>
          <dd>{server.hostname ?? NO_DATA}</dd>
        </div>
        <div class="facts__row">
          <dt>Windows</dt>
          <dd>{server.osRelease ?? NO_DATA}</dd>
        </div>
        <div class="facts__row">
          <dt>Версия портала</dt>
          <dd>{server.version}</dd>
        </div>
        <div class="facts__row">
          <dt>Портал запущен</dt>
          <dd>{formatDateTime(server.startedAt)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function SystemPage() {
  const { system } = useData();
  const isAdmin = useIsAdmin();
  const data = system.data;

  let body = null;
  if (!data && system.error) {
    body = <ErrorState failure={system.error} onRetry={system.refresh} busy={system.loading} />;
  } else if (!data) {
    body = (
      <Loading label="Собираем данные о системе…">
        <div class="tile-grid">
          <Skeleton kind="tile" />
          <Skeleton kind="tile" />
          <Skeleton kind="tile" />
          <Skeleton kind="tile" />
        </div>
      </Loading>
    );
  } else {
    body = (
      <>
        <AlertList alerts={data.alerts} />
        <section class="page-section">
          <h2 class="section-title">Нагрузка</h2>
          <div class="tile-grid">
            <CpuTile data={data} />
            <MemoryTile data={data} />
            <UptimeTile data={data} />
            <TemperatureTile data={data} />
          </div>
        </section>
        <section class="page-section">
          <h2 class="section-title">Место на дисках</h2>
          {data.volumes.length === 0 ? (
            <p class="tile__text">Диски для контроля места не указаны в настройках.</p>
          ) : (
            <div class="tile-grid">
              {data.volumes.map((volume) => (
                <VolumeTile key={volume.path} volume={volume} />
              ))}
            </div>
          )}
        </section>
        <section class="page-section">
          <h2 class="section-title">Доступ, печать и копии</h2>
          <div class="tile-grid">
            <RemoteTile data={data} isAdmin={isAdmin} />
            <PrinterTile data={data} />
            <BackupTile data={data} />
          </div>
        </section>
        {isAdmin ? <DisksSection data={data} /> : null}
        {isAdmin ? <ComputerSection data={data} /> : null}
      </>
    );
  }

  return (
    <div class="page">
      <PageHeader
        title="Состояние системы"
        icon={Activity}
        lead="Как себя чувствует домашний компьютер. Здесь только измеренные значения, у каждого указано время."
      >
        {system.receivedAt ? (
          <p class="meta">
            Данные получены <RelativeTime value={system.receivedAt} />
          </p>
        ) : null}
      </PageHeader>
      {body}
    </div>
  );
}
