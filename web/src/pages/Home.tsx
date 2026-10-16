import {
  CalendarDays,
  Clapperboard,
  DatabaseBackup,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  HardDrive,
  Images,
  Printer,
  Server,
} from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import type { ServiceStatus, SystemResponse } from '../../../shared/api.ts';
import { AlertList } from '../components/AlertList.tsx';
import type { IconComponent } from '../components/icons.ts';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { ServiceCard } from '../components/ServiceCard.tsx';
import { Skeleton } from '../components/Skeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { useNow } from '../hooks/useNow.ts';
import type { PollingResult } from '../hooks/usePolling.ts';
import { formatDuration, formatFreeOf, formatLongDate } from '../lib/format.ts';
import { greetingLine } from '../lib/greeting.ts';
import {
  BACKUP_STATE,
  findService,
  LOW_SPACE,
  openableUrl,
  PRINTER_STATE,
  SERVER_DOWN,
  SERVER_UP,
  SERVICE_PAGES,
  SERVICE_STATE,
  type ServicePageKind,
  SPACE_OK,
  type StatusView,
  TAILSCALE_STATE,
  UNKNOWN,
} from '../lib/labels.ts';
import { useData, useSession } from '../state.tsx';

/** Status for a service tile: from the server list, «Не настроено» if the server does not know it. */
function serviceStatus(service: ServiceStatus | undefined, loaded: boolean): StatusView | null {
  if (service) return SERVICE_STATE[service.state];
  return loaded ? SERVICE_STATE.not_configured : null;
}

/** The one bold element: the cinema as a softly lit projector screen. */
function CinemaScreen(props: { service: ServiceStatus | undefined; loaded: boolean; failed: boolean }) {
  const { service } = props;
  const copy = SERVICE_PAGES.media;
  const url = openableUrl(service);
  const status = props.failed && !service ? UNKNOWN : serviceStatus(service, props.loaded);
  return (
    <section class={url ? 'screen screen--on' : 'screen'} aria-labelledby="cinema-title">
      <div class="screen__head">
        <Clapperboard class="screen__icon" size={28} aria-hidden="true" />
        <h2 id="cinema-title" class="screen__title">
          {service?.name ?? copy.name}
        </h2>
        {status ? <StatusBadge status={status} /> : <Skeleton kind="badge" />}
      </div>
      <p class="screen__desc">{service?.description ?? copy.purpose}</p>
      {url ? (
        <div class="screen__actions">
          <a
            class="button button--primary button--large"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть кинотеатр
            <ExternalLink size={20} aria-hidden="true" />
            <span class="visually-hidden"> (откроется в новой вкладке)</span>
          </a>
        </div>
      ) : (
        <>
          {props.loaded || service ? (
            <div class="screen__note">
              <p>{service?.message ?? 'Кинотеатр ещё не настроен.'}</p>
              {service?.hint ? <p class="screen__hint">{service.hint}</p> : null}
            </div>
          ) : null}
          <div class="screen__actions">
            <a class="button button--secondary" href={copy.path}>
              Подробнее<span class="visually-hidden"> о кинотеатре</span>
            </a>
          </div>
        </>
      )}
      {service?.checkedAt ? (
        <p class="meta screen__meta">
          Проверено <RelativeTime value={service.checkedAt} />
        </p>
      ) : null}
    </section>
  );
}

const TILE_KINDS: ReadonlyArray<{ kind: Exclude<ServicePageKind, 'media'>; icon: IconComponent }> = [
  { kind: 'photos', icon: Images },
  { kind: 'files', icon: FolderOpen },
  { kind: 'downloads', icon: Download },
];

function ServiceTiles(props: {
  services: ServiceStatus[] | undefined;
  loaded: boolean;
  system: SystemResponse | null;
  systemFailed: boolean;
}) {
  const calendar = findService(props.services, 'calendar');
  const calendarUrl = openableUrl(calendar);
  const printer = props.system?.printer;
  return (
    <ul class="card-grid">
      {TILE_KINDS.map(({ kind, icon }) => {
        const service = findService(props.services, kind);
        const copy = SERVICE_PAGES[kind];
        return (
          <ServiceCard
            key={kind}
            name={service?.name ?? copy.name}
            icon={icon}
            status={serviceStatus(service, props.loaded)}
            text={service?.message ?? (props.loaded ? 'Сервис ещё не настроен.' : null)}
            href={copy.path}
          />
        );
      })}
      <ServiceCard
        name="Печать"
        icon={Printer}
        status={printer ? PRINTER_STATE[printer.state] : props.systemFailed ? UNKNOWN : null}
        text={printer ? (printer.name ?? printer.message) : null}
        href="/print"
      />
      <ServiceCard
        name={calendar?.name ?? 'Календарь'}
        icon={CalendarDays}
        status={serviceStatus(calendar, props.loaded)}
        text={calendar?.message ?? (props.loaded ? 'Семейный календарь пока не подключён.' : null)}
        href={calendarUrl}
        external
      />
    </ul>
  );
}

function StatusRow(props: {
  icon: IconComponent;
  label: string;
  status: StatusView | null;
  children?: ComponentChildren;
}) {
  const Icon = props.icon;
  return (
    <li class="status-row">
      <Icon class="status-row__icon" size={20} aria-hidden="true" />
      <div class="status-row__main">
        <p class="status-row__label">{props.label}</p>
        {props.children ? <p class="status-row__detail">{props.children}</p> : null}
      </div>
      {props.status ? <StatusBadge status={props.status} /> : <Skeleton kind="badge" />}
    </li>
  );
}

function HouseStatus(props: { system: PollingResult<SystemResponse> }) {
  const { data, error } = props.system;
  const waiting = !data && !error;
  const volume = data?.volumes[0];
  const uptime = data?.server.uptimeSeconds;
  let serverStatus: StatusView | null = null;
  let serverDetail: ComponentChildren = null;
  if (error) {
    serverStatus = SERVER_DOWN;
    serverDetail = 'Портал не получает ответа от домашнего компьютера.';
  } else if (data) {
    serverStatus = SERVER_UP;
    serverDetail =
      uptime?.value != null
        ? `Без перезагрузки ${formatDuration(uptime.value)}`
        : (uptime?.reason ?? 'Время работы неизвестно');
  }
  let diskStatus: StatusView | null = null;
  let diskDetail: ComponentChildren = null;
  if (data) {
    if (!volume) {
      diskStatus = UNKNOWN;
      diskDetail = 'Диски для контроля не указаны.';
    } else if (volume.totalBytes == null || volume.freeBytes == null) {
      diskStatus = UNKNOWN;
      diskDetail = volume.reason ?? 'Объём диска не удалось прочитать.';
    } else {
      diskStatus = volume.lowSpace ? LOW_SPACE : SPACE_OK;
      diskDetail = `${formatFreeOf(volume.freeBytes, volume.totalBytes)} (${volume.path})`;
    }
  } else if (error) {
    diskStatus = UNKNOWN;
  }
  const remote = data?.tailscale;
  const backup = data?.backup;
  return (
    <section class="home-section">
      <div class="section-head">
        <h2 id="house-title" class="section-title">
          Дом
        </h2>
        <a class="text-link" href="/system">
          Подробнее о системе
        </a>
      </div>
      <ul class="status-list">
        <StatusRow icon={Server} label="Сервер" status={serverStatus}>
          {serverDetail}
        </StatusRow>
        <StatusRow
          icon={Globe}
          label="Удалённый доступ"
          status={remote ? TAILSCALE_STATE[remote.state] : waiting ? null : UNKNOWN}
        >
          {remote
            ? remote.state === 'running'
              ? 'Портал открывается с устройств семьи через Tailscale.'
              : (remote.reason ?? 'Из других мест портал сейчас не открыть.')
            : null}
        </StatusRow>
        <StatusRow icon={HardDrive} label="Место на диске" status={diskStatus}>
          {diskDetail}
        </StatusRow>
        <StatusRow
          icon={DatabaseBackup}
          label="Резервные копии"
          status={backup ? BACKUP_STATE[backup.state] : waiting ? null : UNKNOWN}
        >
          {backup?.message ?? null}
        </StatusRow>
      </ul>
      {props.system.receivedAt ? (
        <p class="meta">
          Обновлено <RelativeTime value={props.system.receivedAt} />
        </p>
      ) : null}
    </section>
  );
}

export function HomePage() {
  const { session } = useSession();
  const { services, system } = useData();
  const now = useNow(60_000);
  const list = services.data?.services;
  const loaded = services.data !== null;
  return (
    <div class="page page--home">
      <div class="home-hero">
        <h1 class="home-hero__greeting" tabIndex={-1}>
          {greetingLine(new Date(now).getHours(), session.user.displayName)}
        </h1>
        <p class="home-hero__date">{formatLongDate(now)}</p>
      </div>
      {system.data ? <AlertList alerts={system.data.alerts} /> : null}
      <CinemaScreen
        service={findService(list, 'media')}
        loaded={loaded}
        failed={services.error !== null && !loaded}
      />
      <section class="home-section">
        <h2 id="services-title" class="section-title">
          Сервисы
        </h2>
        <ServiceTiles
          services={list}
          loaded={loaded}
          system={system.data}
          systemFailed={system.error !== null}
        />
      </section>
      <HouseStatus system={system} />
    </div>
  );
}
