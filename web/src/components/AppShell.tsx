import {
  Bell,
  Clapperboard,
  Download,
  Ellipsis,
  House,
  ListChecks,
  LogOut,
  MessagesSquare,
  Printer,
  Server,
  Sparkles,
  UserRound,
} from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { SessionUser } from '../../../shared/api.ts';
import { useChat } from '../chat/ChatProvider.tsx';
import { useFeatures } from '../features.tsx';
import { ROLE_LABEL } from '../lib/labels.ts';
import { NAV_GROUPS, type NavGroup } from '../lib/nav-groups.ts';
import { SearchButton } from '../search/Search.tsx';
import { useData, useSession } from '../state.tsx';
import { ConnectionBanner, DemoBanner } from './Banners.tsx';
import type { IconComponent } from './icons.ts';
import { SectionTabs } from './SectionTabs.tsx';

interface NavItem {
  id: string;
  /** Where a click leads: the first page of the section that the person may open. */
  path: string;
  /** All the pages of the section (the section is «current» on any of them). */
  paths: readonly string[];
  label: string;
  icon: IconComponent;
  /** Shorter text for the bottom bar, where five items share a phone's width. */
  short?: string;
}

const ICONS: Record<string, IconComponent> = {
  home: House,
  olivia: Sparkles,
  chat: MessagesSquare,
  notifications: Bell,
  planner: ListChecks,
  media: Clapperboard,
  downloads: Download,
  print: Printer,
  server: Server,
  account: UserRound,
};

/** In the bottom tab bar on phones; everything else is under «Ещё». */
const PRIMARY_IDS = ['home', 'media', 'chat', 'olivia'];

/** The sections this person may see: a section whose pages are all off (or all for administrators) is hidden. */
function visibleItems(
  group: readonly NavGroup[],
  isAdmin: boolean,
  pageOn: (path: string) => boolean,
): NavItem[] {
  const items: NavItem[] = [];
  for (const section of group) {
    const tabs = section.tabs.filter((tab) => (isAdmin || tab.adminOnly !== true) && pageOn(tab.path));
    const first = tabs[0];
    if (!first) continue;
    items.push({
      id: section.id,
      path: tabs.some((tab) => tab.path === section.to) ? section.to : first.path,
      paths: section.tabs.map((tab) => tab.path),
      label: section.label,
      icon: ICONS[section.id] ?? House,
      ...(section.short ? { short: section.short } : {}),
    });
  }
  return items;
}

const normal = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** Number of things waiting in a section (unread messages, unseen notifications), by section. */
function useBadges(): Record<string, number> {
  const { unread, notifications } = useChat();
  return { chat: unread, notifications: notifications?.unread ?? 0 };
}

function NavLink(props: {
  item: NavItem;
  path: string;
  class: string;
  badges: Record<string, number>;
  compact?: boolean;
  onClick?: () => void;
}) {
  const { item } = props;
  const Icon = item.icon;
  const active = item.paths.includes(normal(props.path));
  const count = props.badges[item.id] ?? 0;
  return (
    <a
      class={props.class}
      href={item.path}
      aria-current={active ? 'page' : undefined}
      onClick={props.onClick}
    >
      <span class="navicon">
        <Icon size={22} aria-hidden="true" />
        {count > 0 ? (
          <span class="navicon__badge">
            {count > 99 ? '99+' : count}
            <span class="visually-hidden"> новых</span>
          </span>
        ) : null}
      </span>
      <span>{props.compact ? (item.short ?? item.label) : item.label}</span>
    </a>
  );
}
function UserBlock(props: { user: SessionUser; onLogout: () => void; class: string }) {
  return (
    <div class={props.class}>
      <p class="user-block__name">
        {props.user.displayName}
        <span class="user-block__role">{ROLE_LABEL[props.user.role]}</span>
      </p>
      <button type="button" class="button button--quiet user-block__logout" onClick={props.onLogout}>
        <LogOut size={18} aria-hidden="true" />
        Выйти
      </button>
    </div>
  );
}

/** Bottom tab bar (≤ 768 px) with the «Ещё» sheet for the remaining sections. */
function TabBar(props: {
  path: string;
  primary: readonly NavItem[];
  secondary: readonly NavItem[];
  user: SessionUser;
  badges: Record<string, number>;
  onLogout: () => void;
}) {
  // The sheet is "open at" a path, so any navigation closes it automatically.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === props.path;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const sheetId = useId();
  const moreActive = props.secondary.some((item) => item.paths.includes(normal(props.path)));

  useEffect(() => {
    if (!open) return;
    sheetRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    const close = (returnFocus: boolean) => {
      setOpenAt(null);
      if (returnFocus) buttonRef.current?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const inside = (node: EventTarget | null) =>
      node instanceof Node && (sheetRef.current?.contains(node) || buttonRef.current?.contains(node));
    const onPointer = (event: PointerEvent) => {
      if (!inside(event.target)) close(false);
    };
    // Focus landing anywhere outside the sheet and its button closes the sheet (a keyboard user
    // tabbing past «Выйти» would otherwise walk onto page elements hidden behind the scrim).
    const onFocusIn = (event: FocusEvent) => {
      if (!inside(event.target)) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open]);

  return (
    <nav class="tabbar" aria-label="Основная навигация">
      <ul class="tabbar__list">
        {props.primary.map((item) => (
          <li key={item.id}>
            <NavLink item={item} path={props.path} class="tabbar__link" badges={props.badges} compact />
          </li>
        ))}
        <li>
          <button
            ref={buttonRef}
            type="button"
            class={moreActive ? 'tabbar__link tabbar__link--active' : 'tabbar__link'}
            aria-expanded={open}
            aria-controls={sheetId}
            onClick={() => setOpenAt(open ? null : props.path)}
          >
            <span class="navicon">
              <Ellipsis size={22} aria-hidden="true" />
              {(props.badges.more ?? 0) > 0 ? (
                <span class="navicon__badge navicon__badge--dot">
                  <span class="visually-hidden">Есть новое</span>
                </span>
              ) : null}
            </span>
            <span>Ещё</span>
          </button>
        </li>
      </ul>
      <div class="scrim" hidden={!open} />
      <div id={sheetId} ref={sheetRef} class="sheet" hidden={!open}>
        <ul class="sheet__list">
          {props.secondary.map((item) => (
            <li key={item.id}>
              <NavLink
                item={item}
                path={props.path}
                class="sheet__link"
                badges={props.badges}
                onClick={() => setOpenAt(null)}
              />
            </li>
          ))}
        </ul>
        <UserBlock user={props.user} onLogout={props.onLogout} class="user-block user-block--sheet" />
      </div>
    </nav>
  );
}

/** Landmarks, skip link, side navigation (wide) / tab bar (narrow), banners and the page. */
export function AppShell(props: { path: string; notice?: string | null; children: ComponentChildren }) {
  const { session, logout } = useSession();
  const { services, system } = useData();
  const isAdmin = session.user.role === 'admin';
  // The session is read once at start-up; the polled data tells when the server switched to demo later.
  const demo =
    session.demo ||
    system.data?.demo === true ||
    services.data?.services.some((service) => service.demo) === true;
  const { pageOn } = useFeatures();
  const items = visibleItems(NAV_GROUPS, isAdmin, pageOn);
  const primary = items.filter((item) => PRIMARY_IDS.includes(item.id));
  const secondary = items.filter((item) => !PRIMARY_IDS.includes(item.id));
  const badges = useBadges();
  const moreCount = secondary.reduce((sum, item) => sum + (badges[item.id] ?? 0), 0);
  const onLogout = () => void logout();

  return (
    <>
      <a class="skip-link" href="#main">
        Перейти к содержимому
      </a>
      <div class="shell">
        <header class="shell__header">
          <a class="brand" href="/">
            <img class="brand__mark" src="/icons/icon.svg" alt="" width={32} height={32} />
            <span class="brand__name">Семейный сервер</span>
          </a>
          <SearchButton />
          <nav class="sidenav" aria-label="Основная навигация">
            <ul class="sidenav__list">
              {items.map((item) => (
                <li key={item.id}>
                  <NavLink item={item} path={props.path} class="sidenav__link" badges={badges} />
                </li>
              ))}
            </ul>
          </nav>
          <UserBlock user={session.user} onLogout={onLogout} class="user-block user-block--side" />
        </header>
        <main id="main" class="shell__main" tabIndex={-1}>
          <div class="shell__banners">
            {demo ? <DemoBanner /> : null}
            {session.channel === 'public' ? (
              <p class="banner banner--info" role="status">
                Вы вошли через внешний адрес. Здесь доступны чат, звонки, файлы и фото; управление сервером и
                запуск загрузок — только через Tailscale или домашнюю сеть.
              </p>
            ) : null}
            {props.notice ? (
              <p class="banner banner--warn" role="alert">
                {props.notice}
              </p>
            ) : null}
            <ConnectionBanner />
          </div>
          <SectionTabs path={props.path} />
          {props.children}
        </main>
        <TabBar
          path={props.path}
          primary={primary}
          secondary={secondary}
          user={session.user}
          badges={{ ...badges, more: moreCount }}
          onLogout={onLogout}
        />
      </div>
    </>
  );
}
