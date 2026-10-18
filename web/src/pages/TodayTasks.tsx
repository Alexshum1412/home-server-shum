import { CalendarClock, ListChecks, TriangleAlert } from 'lucide-preact';
import { useState } from 'preact/hooks';
import type { TasksResponse, TaskView } from '../../../shared/api.ts';
import { apiPost } from '../api.ts';
import { useResource } from '../hooks/useResource.ts';
import { dueText, isOverdue, tasksForToday, wallMoment } from '../lib/tasks.ts';
import { useSession } from '../state.tsx';

const SHOWN = 5;

/**
 * «Дела на сегодня» for the home page: what is due today or already overdue and is for this person
 * (or for nobody in particular), with a box to tick it off. Like «Сегодня и завтра», it shows only when
 * there is something to show: a task list that cannot be read must never get in the way of the rest
 * of the home page.
 */
export function TodayTasks(props: { now: number }) {
  const { session } = useSession();
  const now = wallMoment(new Date(props.now));
  const data = useResource<TasksResponse>(`/api/tasks?until=${now.day}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const list = tasksForToday(data.data?.tasks ?? [], session.user.username, now);
  if (list.length === 0 && !failed) return null;

  async function tick(task: TaskView) {
    if (busy) return;
    setBusy(task.id);
    setFailed(false);
    try {
      await apiPost(`/api/tasks/${task.id}/done`, {
        done: true,
        occurrence: task.repeat !== 'none' ? task.due : null,
      });
      data.reload();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section class="home-section" aria-labelledby="today-tasks-title">
      <h2 id="today-tasks-title" class="section-title">
        <ListChecks class="section-title__icon" size={20} aria-hidden="true" />
        Дела на сегодня
      </h2>
      {failed ? (
        <p class="form-error" role="alert">
          Не удалось отметить дело. Откройте «Дела» и попробуйте ещё раз.
        </p>
      ) : null}
      <ul class="tasks">
        {list.slice(0, SHOWN).map((task) => {
          const overdue = isOverdue(task, now);
          return (
            <li key={task.id} class={overdue ? 'task task--compact task--overdue' : 'task task--compact'}>
              <label class="task__check">
                <input
                  type="checkbox"
                  checked={false}
                  disabled={busy === task.id}
                  aria-labelledby={`today-task-${task.id}`}
                  onChange={() => void tick(task)}
                />
              </label>
              <div class="task__body">
                <p id={`today-task-${task.id}`} class="task__title">
                  {task.title}
                </p>
                <p class="task__meta">
                  {overdue ? (
                    <span class="task__chip task__chip--bad">
                      <TriangleAlert size={16} aria-hidden="true" />
                      Просрочено: {dueText(task, now.day)}
                    </span>
                  ) : (
                    <span class="task__chip">
                      <CalendarClock size={16} aria-hidden="true" />
                      {dueText(task, now.day)}
                    </span>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      {list.length > SHOWN ? <p class="meta">И ещё дел на сегодня: {list.length - SHOWN}.</p> : null}
      <a class="text-link" href="/tasks">
        Все дела
      </a>
    </section>
  );
}
