import {
  Activity,
  Bell,
  CalendarDays,
  Clapperboard,
  Download,
  Ellipsis,
  FolderOpen,
  House,
  Images,
  LogOut,
  MessagesSquare,
  NotebookPen,
  Printer,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserRound,
} from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { SessionUser } from '../../../shared/api.ts';
import { useChat } from '../chat/ChatProvider.tsx';
import { ROLE_LABEL } from '../lib/labels.ts';
import { isActivePath, isAdminOnly, matchRoute } from '../lib/routes.ts';
import { useData, useSession } from '../state.tsx';
import { ConnectionBanner, DemoBanner } from './Banners.tsx';
import type { IconComponent } from './icons.ts';

interface NavItem {
  path: string;
  label: string;
  icon: IconComponent;
  /** Shorter text for the bottom bar, where six items share a phone's width. */
  short?: string;
}

/** Always visible: in the bottom tab bar on phones. */
const PRIMARY: readonly NavItem[] = [
  { path: '/', label: 'Главная', icon: House },
  { path: '/cinema', label: 'Кинотеатр', icon: Clapperboard, short: 'Кино' },
  { path: '/chat', label: 'Чат', icon: MessagesSquare },
  { path: '/photos', label: 'Фото', icon: Images },
  { path: '/files', label: 'Файлы', icon: FolderOpen },
];

/** Under «Ещё» on phones. */
const SECONDARY: readonly NavItem[] = [
  { path: '/olivia', label: 'Оливия', icon: Sparkles },
  { path: '/notifications', label: 'Уведомления', icon: Bell },
  { path: '/calendar', label: 'Календарь', icon: CalendarDays },
  { path: '/notes', label: 'Заметки', icon: NotebookPen },
  { path: '/downloads', label: 'Загрузки', icon: Download },
  { path: '/print', label: 'Печать', icon: Printer },
  { path: '/system', label: 'Состояние', icon: Activity },
  { path: '/help', label: 'Подключение', icon: Smartphone },
  { path: '/admin', label: 'Администрирование', icon: ShieldCheck },
  { path: '/account', label: 'Мой профиль', icon: UserRound },
];

/** Number of things waiting in a section (unread messages, unseen notifications). */
function useBadges(): Record<string, number> {
  const { unread, notifications } = useChat();
  return { '/chat': unread, '/notifications': notifications?.unread ?? 0 };
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
  const active = isActivePath(props.path, item.path);
  const count = props.badges[item.path] ?? 0;
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
  const moreActive = props.secondary.some((item) => isActivePath(props.path, item.path));

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
        {PRIMARY.map((item) => (
          <li key={item.path}>
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
            <li key={item.path}>
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
  const secondary = SECONDARY.filter((item) => isAdmin || !isAdminOnly(matchRoute(item.path)));
  const badges = useBadges();
  const moreCount = secondary.reduce((sum, item) => sum + (badges[item.path] ?? 0), 0);
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
          <nav class="sidenav" aria-label="Основная навигация">
            <ul class="sidenav__list">
              {[...PRIMARY, ...secondary].map((item) => (
                <li key={item.path}>
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
          {props.children}
        </main>
        <TabBar
          path={props.path}
          secondary={secondary}
          user={session.user}
          badges={{ ...badges, more: moreCount }}
          onLogout={onLogout}
        />
      </div>
    </>
  );
}
