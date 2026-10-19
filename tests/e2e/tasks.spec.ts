import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { VIEWPORTS } from './fixtures.ts';
import { expectNoHorizontalOverflow, signIn } from './helpers.ts';

// The tests share one server and one set of accounts: they run in order, and every title carries a
// short tag of its own run, so a retry never meets the leftovers of the first attempt.
test.describe.configure({ mode: 'serial' });

const pad = (n: number) => String(n).padStart(2, '0');

/** A day of THIS computer (the server runs on it too): «YYYY-MM-DD», `offset` days from today. */
function day(offset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const tag = () => Math.random().toString(36).slice(2, 6);

async function addTask(page: Page, body: Record<string, unknown>) {
  const res = await page.request.post('/api/tasks', { data: body });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; title: string };
}

const row = (page: Page, title: string) => page.locator('.task', { hasText: title });
const group = (page: Page, name: string) => page.getByRole('region', { name });
const quickAdd = (page: Page) => page.locator('form.task-add');

test.describe('family tasks', () => {
  test('a task is added in one line, shown by date, ticked off and kept after a reload', async ({ page }) => {
    const t = tag();
    await signIn(page, 'family', '/tasks');
    await expect(page.getByRole('heading', { level: 1, name: 'Дела' })).toBeVisible();

    // overdue, today, tomorrow, later, no date — and one added with the quick line
    await addTask(page, { title: `Заплатить за свет ${t}`, due: day(-2) });
    await addTask(page, { title: `Позвонить бабушке ${t}`, due: day(0), dueTime: '23:58' });
    await addTask(page, { title: `Купить билеты ${t}`, due: day(1) });
    await addTask(page, { title: `Сменить шины ${t}`, due: day(9) });
    await page.reload();

    await quickAdd(page).getByLabel('Новое дело').fill(`Записаться к врачу ${t}`);
    await quickAdd(page).getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Дело добавлено' })).toBeVisible();
    await expect(quickAdd(page).getByLabel('Новое дело')).toHaveValue('');

    const headings = await page.locator('main h2.section-title').allTextContents();
    const names = headings.map((text) => text.replace(/[:\s\d]+$/u, '').trim());
    const wanted = ['Просрочено', 'Сегодня', 'Завтра', 'Позже', 'Без срока'];
    expect(names.filter((name) => wanted.includes(name))).toEqual(wanted);
    await expect(
      group(page, 'Просрочено').locator('.task', { hasText: `Заплатить за свет ${t}` }),
    ).toContainText('Просрочено: ');
    await expect(group(page, 'Завтра').locator('.task', { hasText: `Купить билеты ${t}` })).toContainText(
      'Завтра',
    );

    // tick: the task moves to «Сделано» and says who did it
    await row(page, `Записаться к врачу ${t}`)
      .getByRole('checkbox', { name: `Записаться к врачу ${t}` })
      .check();
    const done = group(page, 'Сделано').locator('.task', { hasText: `Записаться к врачу ${t}` });
    await expect(done).toContainText('Сделано: Тестовая семья');
    await page.reload();
    await expect(
      group(page, 'Сделано').locator('.task', { hasText: `Записаться к врачу ${t}` }),
    ).toBeVisible();
    // and back
    await row(page, `Записаться к врачу ${t}`).getByRole('checkbox').uncheck();
    await expect(
      group(page, 'Без срока').locator('.task', { hasText: `Записаться к врачу ${t}` }),
    ).toBeVisible();
  });

  test('a task with a date, a time and a repeat is made in the dialog; ticking it moves it to the next time', async ({
    page,
  }) => {
    const t = tag();
    await signIn(page, 'family', '/tasks');
    await quickAdd(page).getByLabel('Новое дело').fill(`Полить цветы ${t}`);
    await quickAdd(page).getByRole('button', { name: 'Срок и напоминание' }).click();
    const dialog = page.getByRole('dialog', { name: 'Новое дело' });
    await expect(dialog).toBeVisible();
    // what was typed on the quick line is taken over; repeat and reminder wait for a date
    await expect(dialog.getByLabel('Что нужно сделать')).toHaveValue(`Полить цветы ${t}`);
    await expect(dialog.getByLabel('Повторять')).toBeDisabled();
    await expect(dialog.getByLabel('Напомнить')).toBeDisabled();
    await dialog.getByLabel('Срок (необязательно)').fill(day(0));
    await dialog.getByLabel('Повторять').selectOption({ label: 'Каждую неделю' });
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog).toBeHidden();

    const item = row(page, `Полить цветы ${t}`);
    await expect(item).toContainText('Сегодня');
    await expect(item).toContainText('Каждую неделю');
    await item.getByRole('checkbox').click();
    await expect(page.getByRole('status').filter({ hasText: 'Следующий раз' })).toBeVisible();
    // still there, open, with the next date and the note about the last time
    await expect(item.locator('.task__chip').first()).not.toContainText('Сегодня');
    await expect(item.getByRole('checkbox')).not.toBeChecked();
    await expect(item).toContainText('В прошлый раз сделал(а): Тестовая семья');
    await item.getByRole('button', { name: /Вернуть/ }).click();
    await expect(item.locator('.task__chip').first()).toContainText('Сегодня');
    await expect(item).not.toContainText('В прошлый раз');
  });

  test('a shopping list takes many items at once, ticks them off and clears what was bought', async ({
    page,
    browser,
  }) => {
    const t = tag();
    await signIn(page, 'family', '/tasks');
    await page.getByRole('button', { name: 'Новый список' }).click();
    const dialog = page.getByRole('dialog', { name: 'Новый список' });
    await dialog.getByLabel('Название списка').fill(`Покупки ${t}`);
    await expect(dialog.getByRole('radio', { name: /Покупки: можно добавить/ })).toBeChecked();
    await dialog.getByRole('button', { name: 'Создать список' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { level: 2, name: `Покупки ${t}` })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(`Покупки ${t}`) })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.getByLabel('Что купить').fill(`молоко ${t}\n- хлеб ${t}\n\n3. яйца ${t}`);
    await page.getByRole('button', { name: 'Добавить в список' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Добавлено пунктов: 3' })).toBeVisible();
    await expect(group(page, 'Нужно купить').locator('.task')).toHaveCount(3);

    await row(page, `молоко ${t}`).getByRole('checkbox').check();
    await row(page, `яйца ${t}`).getByRole('checkbox').check();
    await expect(group(page, 'Куплено').locator('.task')).toHaveCount(2);
    await expect(group(page, 'Куплено').locator('.task', { hasText: `молоко ${t}` })).toContainText(
      'Куплено: Тестовая семья',
    );

    // another member of the family sees the shared list, ticks the rest, but cannot rename or delete the list
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, 'chatter', '/tasks');
    await otherPage.getByRole('link', { name: new RegExp(`Покупки ${t}`) }).click();
    await expect(otherPage.getByRole('heading', { level: 2, name: `Покупки ${t}` })).toBeVisible();
    await expect(otherPage.getByRole('button', { name: 'Переименовать список' })).toHaveCount(0);
    await expect(otherPage.getByRole('button', { name: 'Удалить список' })).toHaveCount(0);
    await otherPage
      .locator('.task', { hasText: `хлеб ${t}` })
      .getByRole('checkbox')
      .check();
    await expect(otherPage.locator('.task', { hasText: `хлеб ${t}` })).toContainText('Куплено: Собеседник');
    await other.close();

    // the author of the list clears everything that was bought, also what the other person ticked
    await page.reload();
    await expect(group(page, 'Куплено').locator('.task')).toHaveCount(3);
    await page.getByRole('button', { name: 'Убрать купленное' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Убрано: 3' })).toBeVisible();
    await expect(page.getByText('Список пока пуст')).toBeVisible();

    page.once('dialog', (confirm) => void confirm.accept());
    await page.getByRole('button', { name: 'Удалить список' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Список удалён' })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(`Покупки ${t}`) })).toHaveCount(0);
  });

  test('a private task and a private list are seen by their author only — not by an administrator either', async ({
    page,
    browser,
  }) => {
    const t = tag();
    await signIn(page, 'family', '/tasks');
    await quickAdd(page).getByLabel('Новое дело').fill(`Подарок на юбилей ${t}`);
    await quickAdd(page).getByLabel('Только для меня').check();
    await quickAdd(page).getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(row(page, `Подарок на юбилей ${t}`)).toContainText('Только для вас');
    await addTask(page, { title: `Общее дело ${t}` });
    const list = await page.request.post('/api/tasks/lists', {
      data: { name: `Тайный список ${t}`, kind: 'todo', private: true },
    });
    expect(list.status()).toBe(201);
    await page.reload();
    await expect(page.getByRole('link', { name: new RegExp(`Тайный список ${t}`) })).toBeVisible();

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, 'admin', '/tasks');
    await expect(row(adminPage, `Общее дело ${t}`)).toBeVisible();
    await expect(adminPage.getByText(`Подарок на юбилей ${t}`)).toHaveCount(0);
    await expect(adminPage.getByText(`Тайный список ${t}`)).toHaveCount(0);
    const seen = await (await adminPage.request.get('/api/tasks')).text();
    expect(seen).not.toContain(`Подарок на юбилей ${t}`);
    expect(seen).not.toContain(`Тайный список ${t}`);
    // the server refuses an administrator too, as if there were nothing
    const mine = (await (await page.request.get('/api/tasks')).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    const secret = mine.tasks.find((task) => task.title === `Подарок на юбилей ${t}`);
    expect(secret).toBeTruthy();
    expect((await adminPage.request.post(`/api/tasks/${secret?.id}/delete`, { data: {} })).status()).toBe(
      404,
    );
    expect(
      (await adminPage.request.post(`/api/tasks/${secret?.id}/done`, { data: { done: true } })).status(),
    ).toBe(404);
    // an administrator may change and delete the SHARED task of somebody else
    const shared = mine.tasks.find((task) => task.title === `Общее дело ${t}`);
    expect((await adminPage.request.post(`/api/tasks/${shared?.id}/delete`, { data: {} })).status()).toBe(
      204,
    );
    await adminContext.close();
  });

  test('a task given to a family member shows up for them and they may tick it, but not change it', async ({
    page,
    browser,
  }) => {
    const t = tag();
    await signIn(page, 'family', '/tasks');
    await page.getByRole('button', { name: 'Срок и напоминание' }).click();
    const dialog = page.getByRole('dialog', { name: 'Новое дело' });
    await dialog.getByLabel('Что нужно сделать').fill(`Забрать посылку ${t}`);
    await dialog.getByLabel('Кому поручить').selectOption({ label: 'Собеседник' });
    // a private task cannot be given away: the choice disappears
    await dialog.getByLabel('Только для меня').check();
    await expect(dialog.getByLabel('Кому поручить')).toHaveCount(0);
    await dialog.getByLabel('Только для меня').uncheck();
    await dialog.getByLabel('Кому поручить').selectOption({ label: 'Собеседник' });
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, `Забрать посылку ${t}`)).toContainText('Поручено: Собеседник');

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, 'chatter', '/tasks');
    const item = row(otherPage, `Забрать посылку ${t}`);
    await expect(item).toContainText('Поручено вам');
    await expect(item).toContainText('Добавил(а): Тестовая семья');
    await expect(item.getByRole('button', { name: /Изменить/ })).toHaveCount(0);
    await item.getByRole('checkbox').check();
    await expect(
      group(otherPage, 'Сделано').locator('.task', { hasText: `Забрать посылку ${t}` }),
    ).toContainText('Сделано: Собеседник');
    await other.close();
  });

  test('a task is changed and deleted by its author', async ({ page }) => {
    const t = tag();
    await signIn(page, 'family', '/tasks');
    await addTask(page, { title: `Старое название ${t}`, note: 'Взять документы' });
    await page.reload();
    await expect(row(page, `Старое название ${t}`)).toContainText('Взять документы');
    await row(page, `Старое название ${t}`)
      .getByRole('button', { name: /Изменить/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Изменить дело' });
    await expect(dialog.getByLabel('Что нужно сделать')).toHaveValue(`Старое название ${t}`);
    await dialog.getByLabel('Что нужно сделать').fill('');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Напишите, что нужно сделать');
    await dialog.getByLabel('Что нужно сделать').fill(`Новое название ${t}`);
    await expect(dialog.getByLabel('Время (необязательно)')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, `Новое название ${t}`)).toBeVisible();
    await expect(row(page, `Старое название ${t}`)).toHaveCount(0);

    page.once('dialog', (confirm) => void confirm.accept());
    await row(page, `Новое название ${t}`)
      .getByRole('button', { name: /Изменить/ })
      .click();
    await page
      .getByRole('dialog', { name: 'Изменить дело' })
      .getByRole('button', { name: 'Удалить' })
      .click();
    await expect(page.getByRole('status').filter({ hasText: 'Дело удалено' })).toBeVisible();
    await expect(row(page, `Новое название ${t}`)).toHaveCount(0);
  });

  test('the home page lists what is to be done today, and a task is ticked from there', async ({ page }) => {
    const t = tag();
    // a person of their own, so that the five places of the block are not taken by the other tests' tasks
    await signIn(page, 'chatter', '/');
    await addTask(page, { title: `Сдать анализы ${t}`, due: day(0) });
    await addTask(page, { title: `Давно пора ${t}`, due: day(-3) });
    await addTask(page, { title: `Завтрашнее ${t}`, due: day(1) });
    await page.reload();
    const block = page.getByRole('region', { name: 'Дела на сегодня' });
    await expect(block).toBeVisible();
    await expect(block.locator('.task', { hasText: `Давно пора ${t}` })).toContainText('Просрочено');
    await expect(block.locator('.task', { hasText: `Сдать анализы ${t}` })).toContainText('Сегодня');
    await expect(block.getByText(`Завтрашнее ${t}`)).toHaveCount(0);
    await block
      .locator('.task', { hasText: `Сдать анализы ${t}` })
      .getByRole('checkbox')
      .click();
    await expect(block.getByText(`Сдать анализы ${t}`)).toHaveCount(0);
    await block.getByRole('link', { name: 'Все дела' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Дела' })).toBeVisible();
    await expect(group(page, 'Сделано').locator('.task', { hasText: `Сдать анализы ${t}` })).toBeVisible();
  });

  test('the section is in the navigation, also under «Ещё» on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'family', '/');
    const bar = page.getByRole('navigation', { name: 'Основная навигация' });
    await bar.getByRole('button', { name: 'Ещё' }).click();
    await bar.getByRole('link', { name: 'Дела' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Дела' })).toBeVisible();
    await expect(page).toHaveURL(/\/tasks$/);
  });
});

test.describe('reminders', () => {
  test('the notification page has the switch «Напоминания о делах», on from the start', async ({ page }) => {
    await signIn(page, 'chatter', '/notifications');
    const box = page.getByRole('checkbox', { name: /Напоминания о делах/ });
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(box).not.toBeChecked();
    await page.reload();
    await expect(page.getByRole('checkbox', { name: /Напоминания о делах/ })).not.toBeChecked();
    await page.getByRole('checkbox', { name: /Напоминания о делах/ }).check();
    await expect(page.getByRole('checkbox', { name: /Напоминания о делах/ })).toBeChecked();
  });

  test('a reminder reaches the person within a minute', async ({ page }) => {
    test.setTimeout(120_000);
    const t = tag();
    await signIn(page, 'family', '/tasks');
    const now = new Date();
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    // due this very minute, reminder «at the time»: the once-a-minute tick of the server tells it
    await addTask(page, { title: `Напомнить про чай ${t}`, due: day(0), dueTime: time, remindBefore: 0 });

    interface Feed {
      notifications: Array<{ kind: string; title: string; body: string; url: string }>;
    }
    const mine = async () => {
      const feed = (await (await page.request.get('/api/notifications')).json()) as Feed;
      return feed.notifications.filter((item) => item.body.includes(`Напомнить про чай ${t}`));
    };
    await expect.poll(async () => (await mine()).length, { timeout: 90_000, intervals: [2_000] }).toBe(1);
    const [item] = await mine();
    expect(item).toMatchObject({ kind: 'reminder', title: 'Напоминание о деле', url: '/tasks' });

    // seen in the portal: the notification list names it (that it is told only once is checked on the server side)
    await page.goto('/notifications');
    await expect(page.getByText(`Напомнить про чай ${t}`)).toBeVisible();
    await expect(page.locator('.note-item__kind', { hasText: 'Напоминание' }).first()).toBeVisible();
  });
});

test.describe('layout and accessibility', () => {
  test('«Дела» fits every screen width, also with long words and a dialog open', async ({ page }) => {
    const t = tag();
    await signIn(page, 'family', '/tasks');
    await addTask(page, {
      title: 'я'.repeat(120),
      note: 'ы'.repeat(300),
      due: day(0),
      dueTime: '09:00',
      remindBefore: 30,
    });
    await addTask(page, { title: `Дело с длинным описанием ${t}`, note: 'слово '.repeat(150), due: day(-1) });
    for (const width of VIEWPORTS) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      await page.goto('/tasks');
      await expect(page.getByRole('heading', { level: 1, name: 'Дела' })).toBeVisible();
      await expect(page.locator('.task').first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'Срок и напоминание' }).click();
    await expect(page.getByRole('dialog', { name: 'Новое дело' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  for (const width of [390, 1440]) {
    test(`«Дела» has no serious or critical axe violations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      await signIn(page, 'family', '/tasks');
      await expect(page.getByRole('heading', { level: 1, name: 'Дела' })).toBeVisible();
      await expect(page.locator('.task').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      const scan = async () => {
        const result = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        return result.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => `${v.id}: ${v.help} (${v.nodes.length})`);
      };
      expect(await scan()).toEqual([]);

      await page.getByRole('button', { name: 'Срок и напоминание' }).click();
      const dialog = page.getByRole('dialog', { name: 'Новое дело' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Срок (необязательно)').fill(day(2));
      expect(await scan()).toEqual([]);
      await dialog.getByRole('button', { name: 'Закрыть' }).click();

      await page.getByRole('button', { name: 'Новый список' }).click();
      await expect(page.getByRole('dialog', { name: 'Новый список' })).toBeVisible();
      expect(await scan()).toEqual([]);
    });
  }

  test('home page with the «Дела на сегодня» block has no serious or critical axe violations', async ({
    page,
  }) => {
    await signIn(page, 'family', '/');
    await addTask(page, { title: `Для проверки ${tag()}`, due: day(0) });
    await page.reload();
    await expect(page.getByRole('region', { name: 'Дела на сегодня' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });
});
