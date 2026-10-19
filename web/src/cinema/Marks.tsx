import { Bookmark, CircleCheck, Heart, Play } from 'lucide-preact';
import type { CatalogItem } from '../../../shared/api.ts';
import { useLists } from './ListsProvider.tsx';
import { type MarkFlag, watchState } from './lists.ts';
import { PosterCard } from './Poster.tsx';

/** What each mark is called, what it does when it is off, and what it does when it is on. */
const MARKS: Record<
  MarkFlag,
  { name: string; hintOff: string; hintOn: string; actionOff: string; actionOn: string }
> = {
  favourite: {
    name: 'Избранное',
    hintOff: 'Добавить в избранное',
    hintOn: 'В избранном — нажмите, чтобы убрать',
    actionOff: 'В избранное',
    actionOn: 'Убрать из избранного',
  },
  later: {
    name: 'Посмотреть позже',
    hintOff: 'Добавить в «Посмотреть позже»',
    hintOn: 'В списке «Посмотреть позже» — нажмите, чтобы убрать',
    actionOff: 'Посмотреть позже',
    actionOn: 'Убрать из «Посмотреть позже»',
  },
  watched: {
    name: 'Просмотрено',
    hintOff: 'Отметить просмотренным',
    hintOn: 'Просмотрено — нажмите, чтобы снять отметку',
    actionOff: 'Отметить просмотренным',
    actionOn: 'Снять отметку «просмотрено»',
  },
};

const ICON = { favourite: Heart, later: Bookmark, watched: CircleCheck } as const;

/**
 * The three small round buttons on a poster. Each is a switch (pressed or not) named after the
 * film; the filled icon is the second cue after the pressed state, and «Просмотрено» is also a chip.
 */
export function PosterMarks(props: { item: CatalogItem; onProblem: (text: string) => void }) {
  const lists = useLists();
  const { item } = props;
  const busy = lists.busy(item.id);
  return (
    <fieldset class="poster-marks">
      <legend class="visually-hidden">Отметки: {item.title}</legend>
      {(['favourite', 'later', 'watched'] as const).map((flag) => {
        const on = lists.has(flag, item.id);
        const Icon = ICON[flag];
        const text = MARKS[flag];
        return (
          <button
            key={flag}
            type="button"
            class={on ? 'poster-marks__button poster-marks__button--on' : 'poster-marks__button'}
            aria-pressed={on}
            aria-label={`${text.name}: ${item.title}`}
            title={on ? text.hintOn : text.hintOff}
            disabled={busy}
            onClick={() => {
              void lists.toggle(item.id, flag).then((problem) => {
                if (problem) props.onProblem(problem);
              });
            }}
          >
            <Icon size={18} aria-hidden="true" fill={on ? 'currentColor' : 'none'} />
          </button>
        );
      })}
    </fieldset>
  );
}

/** A card of a row or grid with its marks; the marks are left out when the person's lists could not be read. */
export function MarkedPoster(props: {
  item: CatalogItem;
  href: string;
  note?: string;
  onProblem: (text: string) => void;
}) {
  const lists = useLists();
  const state = watchState(lists.sets, props.item);
  return (
    <div class="poster-wrap">
      <PosterCard item={props.item} href={props.href} status={state === 'none' ? null : state} />
      {lists.ready ? <PosterMarks item={props.item} onProblem={props.onProblem} /> : null}
      {props.note ? <p class="poster-wrap__note">{props.note}</p> : null}
    </div>
  );
}

/** The marks on the film's own window: text buttons that say what they will do, and the state as icon + word. */
export function DialogMarks(props: {
  item: CatalogItem;
  onProblem: (text: string) => void;
  onChanged?: () => void;
}) {
  const lists = useLists();
  const { item } = props;
  if (!lists.ready) {
    return (
      <p class="meta" role="status">
        {lists.loading
          ? 'Загружаем ваши отметки…'
          : 'Отметки «Избранное», «Посмотреть позже» и «Просмотрено» сейчас недоступны.'}
      </p>
    );
  }
  const busy = lists.busy(item.id);
  const state = watchState(lists.sets, item);
  return (
    <div class="dialog-marks">
      <ul class="dialog-marks__state" aria-label="Ваши отметки">
        {lists.has('favourite', item.id) ? (
          <li class="badge badge--info">
            <Heart class="badge__icon" size={16} aria-hidden="true" fill="currentColor" />В избранном
          </li>
        ) : null}
        {lists.has('later', item.id) ? (
          <li class="badge badge--info">
            <Bookmark class="badge__icon" size={16} aria-hidden="true" fill="currentColor" />В списке
            «Посмотреть позже»
          </li>
        ) : null}
        {state === 'watched' ? (
          <li class="badge badge--ok">
            <CircleCheck class="badge__icon" size={16} aria-hidden="true" />
            Просмотрено
          </li>
        ) : null}
        {state === 'watching' ? (
          <li class="badge badge--neutral">
            <Play class="badge__icon" size={16} aria-hidden="true" />
            Смотрю
          </li>
        ) : null}
        {!lists.has('favourite', item.id) && !lists.has('later', item.id) && state === 'none' ? (
          <li class="badge badge--neutral">Пока без отметок</li>
        ) : null}
      </ul>
      <div class="dialog-marks__buttons">
        {(['favourite', 'later', 'watched'] as const).map((flag) => {
          const on = lists.has(flag, item.id);
          const Icon = ICON[flag];
          const text = MARKS[flag];
          return (
            <button
              key={flag}
              type="button"
              class="button button--secondary"
              disabled={busy}
              onClick={() => {
                void lists.toggle(item.id, flag).then((problem) => {
                  if (problem) props.onProblem(problem);
                  else props.onChanged?.();
                });
              }}
            >
              <Icon size={18} aria-hidden="true" fill={on && flag !== 'watched' ? 'currentColor' : 'none'} />
              {on ? text.actionOn : text.actionOff}
            </button>
          );
        })}
      </div>
    </div>
  );
}
