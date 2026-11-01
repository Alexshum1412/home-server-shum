import { CircleHelp } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useFeatures } from '../features.tsx';
import { groupOfPath } from '../lib/nav-groups.ts';
import { useIsAdmin } from '../state.tsx';
import { PAGE_TEXT, pageSteps, type TourStep, WELCOME_STEPS } from './steps.ts';

const SEEN_KEY = 'fs-tour-seen-v1';

interface TourApi {
  /** Starts the walk (the whole portal), or the hints of the current page when `forPage` has tabs. */
  start: (forPage?: string) => void;
  seenHere: () => boolean;
}

const Ctx = createContext<TourApi>({ start: () => undefined, seenHere: () => true });
export const useTour = () => useContext(Ctx);

const visible = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement && element.getClientRects().length > 0;

/** The element to light up: the first visible one; a section hidden under «Ещё» on a phone lights «Ещё» instead. */
function findTarget(selector: string | null): { element: HTMLElement | null; moved: boolean } {
  if (!selector) return { element: null, moved: false };
  for (const element of document.querySelectorAll(selector))
    if (visible(element)) return { element, moved: false };
  const more = document.querySelector('[data-tour="more"]');
  return { element: visible(more) ? more : null, moved: true };
}

function Walk(props: { steps: TourStep[]; onEnd: (finished: boolean) => void; offerWhole?: () => void }) {
  const [index, setIndex] = useState(0);
  const step = props.steps[index] as TourStep;
  const card = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [moved, setMoved] = useState(false);

  useLayoutEffect(() => {
    const place = () => {
      const found = findTarget(step.target);
      setMoved(found.moved);
      if (!found.element) return setBox(null);
      found.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = found.element.getBoundingClientRect();
      setBox({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [index, step.target]);

  useEffect(() => {
    card.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onEnd(false);
      if (event.key === 'ArrowRight' || event.key === 'Enter') next();
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const last = index === props.steps.length - 1;
  function next() {
    if (last) props.onEnd(true);
    else setIndex(index + 1);
  }

  // The card stays under or beside the lit element; in the middle when there is nothing to light.
  const narrow = window.innerWidth < 768;
  const style: Record<string, string> = {};
  if (box && !narrow) {
    const roomBelow = window.innerHeight - (box.top + box.height);
    style.left = `${Math.min(Math.max(12, box.left + box.width + 16), window.innerWidth - 392)}px`;
    style.top = `${Math.max(12, Math.min(box.top, window.innerHeight - 280))}px`;
    if (box.left + box.width + 400 > window.innerWidth) {
      style.left = `${Math.max(12, box.left)}px`;
      style.top = roomBelow > 260 ? `${box.top + box.height + 16}px` : `${Math.max(12, box.top - 260)}px`;
    }
  }
  return (
    <div class="tour" role="presentation">
      {box ? (
        <div
          class="tour__spot"
          style={{
            top: `${box.top}px`,
            left: `${box.left}px`,
            width: `${box.width}px`,
            height: `${box.height}px`,
          }}
        />
      ) : (
        <div class="tour__dim" />
      )}
      <div
        ref={card}
        class={
          box && !narrow
            ? 'tour__card tour__card--placed'
            : narrow
              ? 'tour__card tour__card--sheet'
              : 'tour__card tour__card--center'
        }
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        tabIndex={-1}
      >
        <p class="meta">
          Шаг {index + 1} из {props.steps.length}
        </p>
        <h2 id="tour-title" class="section-title">
          {step.title}
        </h2>
        <p>{step.text}</p>
        {moved ? <p class="meta">Этот раздел спрятан под кнопкой «Ещё».</p> : null}
        <div class="action-row">
          {index > 0 ? (
            <button type="button" class="button button--quiet" onClick={() => setIndex(index - 1)}>
              Назад
            </button>
          ) : null}
          <button type="button" class="button button--primary" onClick={next}>
            {last ? 'Готово' : 'Дальше'}
          </button>
          {last && props.offerWhole ? (
            <button type="button" class="button button--secondary" onClick={props.offerWhole}>
              Показать весь портал
            </button>
          ) : null}
          {!last ? (
            <button type="button" class="button button--quiet" onClick={() => props.onEnd(false)}>
              Пропустить
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Step-by-step hints: the whole portal at the first sign-in, and again (or for one section) on the «?» button. */
export function TourProvider(props: { path: string; children: ComponentChildren }) {
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [wholeAfter, setWholeAfter] = useState(false);
  const isAdmin = useIsAdmin();
  const { pageOn } = useFeatures();

  const seenHere = useCallback(() => {
    try {
      return localStorage.getItem(SEEN_KEY) === '1';
    } catch {
      return true;
    }
  }, []);

  const start = useCallback(
    (forPage?: string) => {
      const group = forPage ? groupOfPath(forPage) : undefined;
      const tabs = (group?.tabs ?? []).filter(
        (tab) => (isAdmin || tab.adminOnly !== true) && pageOn(tab.path),
      );
      const hints = forPage ? pageSteps(forPage, tabs) : [];
      if (hints.length > 0) {
        setWholeAfter(true);
        setSteps(hints);
      } else {
        setWholeAfter(false);
        setSteps(WELCOME_STEPS.filter((s) => s.target === null || findTarget(s.target).element !== null));
      }
    },
    [isAdmin, pageOn],
  );

  const end = (finished: boolean) => {
    setSteps(null);
    if (finished || !wholeAfter) {
      try {
        localStorage.setItem(SEEN_KEY, '1');
      } catch {
        // nothing: the walk will be offered again next time
      }
    }
  };
  const api = useMemo(() => ({ start, seenHere }), [start, seenHere]);
  void PAGE_TEXT;
  return (
    <Ctx.Provider value={api}>
      {props.children}
      {steps && steps.length > 0 ? (
        <Walk
          steps={steps}
          onEnd={end}
          {...(wholeAfter
            ? {
                offerWhole: () => {
                  setWholeAfter(false);
                  setSteps(
                    WELCOME_STEPS.filter((s) => s.target === null || findTarget(s.target).element !== null),
                  );
                },
              }
            : {})}
        />
      ) : null}
    </Ctx.Provider>
  );
}

/** The «?» button in the header. */
export function HelpButton(props: { path: string }) {
  const tour = useTour();
  return (
    <button
      type="button"
      class="button button--quiet help-button"
      data-tour="help"
      onClick={() => tour.start(props.path)}
      aria-label="Подсказки: как пользоваться"
    >
      <CircleHelp size={22} aria-hidden="true" />
      <span class="help-button__text">Подсказки</span>
    </button>
  );
}
