import {
  Bell,
  Clapperboard,
  Download,
  ListChecks,
  MessagesSquare,
  Printer,
  Server,
  Sparkles,
  UserRound,
} from 'lucide-preact';
import { useChat } from '../chat/ChatProvider.tsx';
import type { IconComponent } from '../components/icons.ts';
import { useFeatures } from '../features.tsx';
import { NAV_GROUPS } from '../lib/nav-groups.ts';
import { useIsAdmin } from '../state.tsx';

const TILES: Record<string, { icon: IconComponent; lead: string }> = {
  olivia: { icon: Sparkles, lead: 'Спросите что угодно: совет, рецепт, поиск, помощь с уроками' },
  chat: { icon: MessagesSquare, lead: 'Переписка и звонки с семьёй' },
  media: { icon: Clapperboard, lead: 'Фильмы, фото и файлы' },
  planner: { icon: ListChecks, lead: 'Дела, покупки, календарь, заметки, сроки' },
  downloads: { icon: Download, lead: 'Скачать файл или фильм по ссылке' },
  notifications: { icon: Bell, lead: 'Что нового для вас' },
  print: { icon: Printer, lead: 'Напечатать документ' },
  server: { icon: Server, lead: 'Всё ли работает, подключение, настройки' },
  account: { icon: UserRound, lead: 'Город, интересы, дайджест, пароль' },
};

/** The first thing on the home page: where to go, in big plain buttons (a section shows how many new things wait in it). */
export function HomeTiles() {
  const { pageOn } = useFeatures();
  const isAdmin = useIsAdmin();
  const { unread, notifications } = useChat();
  const counts: Record<string, number> = { chat: unread, notifications: notifications?.unread ?? 0 };
  return (
    <nav class="home-tiles" aria-label="Разделы портала">
      <ul class="home-tiles__list">
        {NAV_GROUPS.filter((group) => group.id !== 'home').flatMap((group) => {
          const tabs = group.tabs.filter((tab) => (isAdmin || tab.adminOnly !== true) && pageOn(tab.path));
          const tile = TILES[group.id];
          const target = tabs.find((tab) => tab.path === group.to) ?? tabs[0];
          if (!tile || !target) return [];
          const Icon = tile.icon;
          const count = counts[group.id] ?? 0;
          return [
            <li key={group.id}>
              <a class="home-tile" href={target.path}>
                <span class="home-tile__icon">
                  <Icon size={28} aria-hidden="true" />
                  {count > 0 ? (
                    <span class="navicon__badge">
                      {count > 99 ? '99+' : count}
                      <span class="visually-hidden"> новых</span>
                    </span>
                  ) : null}
                </span>
                <span class="home-tile__text">
                  <strong>{group.label}</strong>
                  <span class="meta">{tile.lead}</span>
                </span>
              </a>
            </li>,
          ];
        })}
      </ul>
    </nav>
  );
}
