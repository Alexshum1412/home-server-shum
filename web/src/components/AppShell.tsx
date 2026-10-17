import {
  Activity,
  Clapperboard,
  Download,
  Ellipsis,
  FolderOpen,
  House,
  Images,
  LogOut,
  Printer,
  ShieldCheck,
  Smartphone,
  UserRound,
} from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { SessionUser } from '../../../shared/api.ts';
import { ROLE_LABEL } from '../lib/labels.ts';
import { isActivePath, isAdminOnly, matchRoute } from '../lib/routes.ts';
import { useData, useSession } from '../state.tsx';
import { ConnectionBanner, DemoBanner } from './Banners.tsx';
import type { IconComponent } from './icons.ts';

interface NavItem {
  path: string;
  label: string;
  icon: IconComponent;
}

/** Always visible: in the bottom tab bar on phones. */
const PRIMARY: readonly NavItem[] = [
  { path: '/', label: 'Главная', icon: House },
  { path: '/cinema', label: 'Кинотеатр', icon: Clapperboard },
  { path: '/photos', label: 'Фото', icon: Images },
  { path: '/files', label: 'Файлы', icon: FolderOpen },
];

/** Under «Ещё» on phones. */
const SECONDARY: readonly NavItem[] = [
  { path: '/downloads', label: 'Загрузки', icon: Download },
  { path: '/print', label: 'Печать', icon: Printer },
  { path: '/system', label: 'Состояние', icon: Activity },
  { path: '/help', label: 'Подключение', icon: Smartphone },
  { path: '/admin', label: 'Администрирование', icon: ShieldCheck },
  { path: '/account', label: 'Мой профиль', icon: UserRound },
];

function NavLink(props: { item: NavItem; path: string; class: string; onClick?: () => void }) {
  const { item } = props;
  const Icon = item.icon;
  const active = isActivePath(props.path, item.path);
  return (
    <a
      class={props.class}
      href={item.path}
      aria-current={active ? 'page' : undefined}
      onClick={props.onClick}
    >
      <Icon size={22} aria-hidden="true" />
      <span>{item.label}</span>
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
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget && !inside(event.relatedTarget)) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    sheetRef.current?.addEventListener('focusout', onFocusOut);
    const sheet = sheetRef.current;
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      sheet?.removeEventListener('focusout', onFocusOut);
    };
  }, [open]);

  return (
    <nav class="tabbar" aria-label="Основная навигация">
      <ul class="tabbar__list">
        {PRIMARY.map((item) => (
          <li key={item.path}>
            <NavLink item={item} path={props.path} class="tabbar__link" />
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
            <Ellipsis size={22} aria-hidden="true" />
            <span>Ещё</span>
          </button>
        </li>
      </ul>
      <div class="scrim" hidden={!open} />
      <div id={sheetId} ref={sheetRef} class="sheet" hidden={!open}>
        <ul class="sheet__list">
          {props.secondary.map((item) => (
            <li key={item.path}>
              <NavLink item={item} path={props.path} class="sheet__link" onClick={() => setOpenAt(null)} />
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
                  <NavLink item={item} path={props.path} class="sidenav__link" />
                </li>
              ))}
            </ul>
          </nav>
          <UserBlock user={session.user} onLogout={onLogout} class="user-block user-block--side" />
        </header>
        <main id="main" class="shell__main" tabIndex={-1}>
          <div class="shell__banners">
            {demo ? <DemoBanner /> : null}
            {props.notice ? (
              <p class="banner banner--warn" role="alert">
                {props.notice}
              </p>
            ) : null}
            <ConnectionBanner />
          </div>
          {props.children}
        </main>
        <TabBar path={props.path} secondary={secondary} user={session.user} onLogout={onLogout} />
      </div>
    </>
  );
}
