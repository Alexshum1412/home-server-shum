import { Clapperboard, Disc3, Library, Play, Tv } from 'lucide-preact';
import type { CatalogItem, CatalogKind } from '../../../shared/api.ts';
import { hueOf } from '../chat/format.ts';

const KIND_LABEL: Record<CatalogKind, string> = {
  movie: 'Фильм',
  series: 'Сериал',
  season: 'Сезон',
  episode: 'Серия',
  track: 'Трек',
  album: 'Альбом',
  book: 'Аудиокнига',
  audiobook: 'Глава',
  video: 'Видео',
  other: 'Файл',
};

export const kindLabel = (kind: CatalogKind): string => KIND_LABEL[kind];

function Glyph(props: { kind: CatalogKind }) {
  const size = 36;
  if (props.kind === 'series' || props.kind === 'season') return <Tv size={size} aria-hidden="true" />;
  if (props.kind === 'album' || props.kind === 'track') return <Disc3 size={size} aria-hidden="true" />;
  if (props.kind === 'book' || props.kind === 'audiobook') return <Library size={size} aria-hidden="true" />;
  return <Clapperboard size={size} aria-hidden="true" />;
}

/** The poster of an item, or a coloured plate with its title when there is none. */
export function Poster(props: { item: CatalogItem; width?: number }) {
  const { item } = props;
  if (item.hasPoster) {
    return (
      <img
        class="poster__img"
        src={`/api/catalog/image/${item.id}?w=${props.width ?? 320}`}
        alt=""
        width={200}
        height={300}
        loading="lazy"
        decoding="async"
      />
    );
  }
  return (
    <span class="poster__plate" style={{ '--poster-hue': String(hueOf(item.id)) }} aria-hidden="true">
      <Glyph kind={item.kind} />
      <span class="poster__plate-title">{item.title}</span>
    </span>
  );
}

/** Share of the item that is already watched, 0–100, or null. */
export function watchedShare(item: CatalogItem): number | null {
  if (!item.resumeSec || !item.durationSec || item.durationSec <= 0) return null;
  return Math.min(99, Math.max(1, Math.round((item.resumeSec / item.durationSec) * 100)));
}

/** A card in a row or grid: opens the item. */
export function PosterCard(props: { item: CatalogItem; href: string; compact?: boolean }) {
  const { item } = props;
  const share = watchedShare(item);
  return (
    <a class={props.compact ? 'poster poster--compact' : 'poster'} href={props.href}>
      <span class="poster__frame">
        <Poster item={item} />
        {share !== null ? (
          <span class="poster__resume" aria-hidden="true">
            <Play size={14} aria-hidden="true" />
            <span class="poster__bar">
              <span class="poster__bar-fill" style={{ width: `${share}%` }} />
            </span>
          </span>
        ) : null}
      </span>
      <span class="poster__title">{item.title}</span>
      <span class="poster__meta">
        {kindLabel(item.kind)}
        {item.year ? ` · ${item.year}` : ''}
        {share !== null ? ` · просмотрено ${share} %` : ''}
      </span>
    </a>
  );
}
