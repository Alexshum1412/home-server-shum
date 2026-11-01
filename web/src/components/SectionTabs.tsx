import { useFeatures } from '../features.tsx';
import { groupOfPath } from '../lib/nav-groups.ts';
import { useIsAdmin } from '../state.tsx';

/** The pages of the section the person is in, as tabs at the top of the page (nothing when the section has one page). */
export function SectionTabs(props: { path: string }) {
  const { pageOn } = useFeatures();
  const isAdmin = useIsAdmin();
  const group = groupOfPath(props.path);
  if (!group) return null;
  const tabs = group.tabs.filter((tab) => (isAdmin || tab.adminOnly !== true) && pageOn(tab.path));
  if (tabs.length < 2) return null;
  const current = props.path.length > 1 ? props.path.replace(/\/+$/, '') : props.path;
  return (
    <nav class="section-tabs" aria-label={`Раздел «${group.label}»`}>
      <ul class="section-tabs__list">
        {tabs.map((tab) => (
          <li key={tab.path}>
            <a
              class="section-tabs__link"
              href={tab.path}
              aria-current={tab.path === current ? 'page' : undefined}
            >
              {tab.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
