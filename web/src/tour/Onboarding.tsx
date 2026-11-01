import { useEffect, useRef, useState } from 'preact/hooks';
import type { ProfileResponse } from '../../../shared/profile.ts';
import { apiGet } from '../api.ts';
import { ProfileEditor } from '../pages/ProfileEditor.tsx';
import { useTour } from './Tour.tsx';

/** At the first sign-in: a short acquaintance (city, interests, Telegram), then the walk through the portal. */
export function Onboarding() {
  const tour = useTour();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let alive = true;
    apiGet<ProfileResponse>('/api/profile').then(
      (response) => {
        if (!alive) return;
        if (!response.profile.onboarded) setOpen(true);
        else if (!tour.seenHere()) setTimeout(() => tour.start(), 600);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);

  function finish() {
    dialog.current?.close();
    setOpen(false);
    setTimeout(() => tour.start(), 400);
  }

  if (!open) return null;
  return (
    <dialog
      ref={dialog}
      class="sheet-dialog"
      aria-labelledby="onboarding-title"
      onCancel={(e) => e.preventDefault()}
    >
      <h2 id="onboarding-title" class="section-title">
        Давайте познакомимся
      </h2>
      <p class="section-lead">
        Расскажите немного о себе: тогда утренний дайджест будет именно про вас (погода в вашем городе, слово
        дня, новости). Всё можно пропустить и поменять потом в «Мой профиль».
      </p>
      {problem ? (
        <p class="banner banner--bad" role="alert">
          {problem}
        </p>
      ) : null}
      <ProfileEditor
        submitLabel="Сохранить и продолжить"
        onSaved={(message) => {
          if (message === 'Сохранено.') finish();
        }}
        onProblem={setProblem}
        secondary={{
          label: 'Позже',
          onClick: () => {
            void import('../api.ts').then(({ apiPost }) =>
              apiPost('/api/profile', { onboarded: true }).catch(() => undefined),
            );
            finish();
          },
        }}
      />
    </dialog>
  );
}
