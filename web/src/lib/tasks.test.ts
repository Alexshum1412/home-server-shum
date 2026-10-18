import { describe, expect, it } from 'vitest';
import type { TaskListView, TaskView } from '../../../shared/api.ts';
import {
  dayWord,
  dueText,
  groupOf,
  groupTasks,
  isOverdue,
  plural,
  remindLabel,
  splitLines,
  tasksForToday,
  tasksOfView,
  wallMoment,
} from './tasks.ts';

const NOW = { day: '2026-10-16', time: '14:00' };

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: over.title ?? 'id',
    title: 'Дело',
    note: '',
    due: null,
    dueTime: null,
    repeat: 'none',
    assignee: null,
    remindBefore: null,
    private: false,
    listId: null,
    owner: 'mama',
    ownerName: 'Мама',
    assigneeName: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    done: false,
    doneAt: null,
    doneBy: null,
    doneByName: null,
    lastDoneAt: null,
    lastDoneByName: null,
    canEdit: true,
    canUndo: false,
    ...over,
  };
}

const list = (over: Partial<TaskListView>): TaskListView => ({
  id: 'l1',
  name: 'Список',
  kind: 'todo',
  private: false,
  owner: 'mama',
  ownerName: 'Мама',
  createdAt: '2026-10-01T10:00:00.000Z',
  canEdit: true,
  ...over,
});

describe('overdue, today, tomorrow, later', () => {
  it('cuts tasks into the groups a person reads', () => {
    expect(groupOf(task({ due: '2026-10-15' }), NOW)).toBe('overdue');
    expect(groupOf(task({ due: '2026-10-16' }), NOW)).toBe('today');
    expect(groupOf(task({ due: '2026-10-16', dueTime: '18:30' }), NOW)).toBe('today');
    expect(groupOf(task({ due: '2026-10-17' }), NOW)).toBe('tomorrow');
    expect(groupOf(task({ due: '2026-10-18' }), NOW)).toBe('later');
    expect(groupOf(task({ due: '2027-01-01' }), NOW)).toBe('later');
    expect(groupOf(task({ due: null }), NOW)).toBe('nodate');
    expect(groupOf(task({ due: '2026-10-01', done: true }), NOW)).toBe('done');
  });

  it('counts a task as overdue once its time of today has passed, not before', () => {
    expect(isOverdue(task({ due: '2026-10-16', dueTime: '13:59' }), NOW)).toBe(true);
    expect(isOverdue(task({ due: '2026-10-16', dueTime: '14:00' }), NOW)).toBe(false);
    expect(isOverdue(task({ due: '2026-10-16', dueTime: null }), NOW)).toBe(false);
    expect(isOverdue(task({ due: '2026-10-16', dueTime: '09:00', done: true }), NOW)).toBe(false);
    expect(isOverdue(task({ due: null }), NOW)).toBe(false);
  });

  it('orders the groups and the tasks inside them', () => {
    const groups = groupTasks(
      [
        task({ title: 'позже', due: '2026-11-01' }),
        task({ title: 'вечером', due: '2026-10-16', dueTime: '20:00' }),
        task({ title: 'весь день', due: '2026-10-16' }),
        task({ title: 'без срока 2', createdAt: '2026-10-03T00:00:00.000Z' }),
        task({ title: 'без срока 1', createdAt: '2026-10-02T00:00:00.000Z' }),
        task({ title: 'вчера', due: '2026-10-15' }),
        task({ title: 'давно', due: '2026-10-01' }),
        task({ title: 'сделано раньше', done: true, doneAt: '2026-10-10T10:00:00.000Z' }),
        task({ title: 'сделано позже', done: true, doneAt: '2026-10-12T10:00:00.000Z' }),
        task({ title: 'завтра', due: '2026-10-17' }),
      ],
      NOW,
    );
    expect(groups.map((g) => g.title)).toEqual([
      'Просрочено',
      'Сегодня',
      'Завтра',
      'Позже',
      'Без срока',
      'Сделано',
    ]);
    expect(groups.map((g) => g.tasks.map((t) => t.title))).toEqual([
      ['давно', 'вчера'],
      ['весь день', 'вечером'],
      ['завтра'],
      ['позже'],
      ['без срока 1', 'без срока 2'],
      ['сделано позже', 'сделано раньше'],
    ]);
  });

  it('leaves out the groups that are empty', () => {
    expect(groupTasks([], NOW)).toEqual([]);
    expect(groupTasks([task({ due: '2026-10-17' })], NOW).map((g) => g.id)).toEqual(['tomorrow']);
  });
});

describe('words', () => {
  it('says the day in plain words', () => {
    expect(dayWord('2026-10-16', '2026-10-16')).toBe('Сегодня');
    expect(dayWord('2026-10-17', '2026-10-16')).toBe('Завтра');
    expect(dayWord('2026-10-15', '2026-10-16')).toBe('Вчера');
    expect(dayWord('2026-10-23', '2026-10-16')).toMatch(/23/);
    expect(dueText({ due: null, dueTime: null }, NOW.day)).toBeNull();
    expect(dueText({ due: '2026-10-16', dueTime: '18:30' }, NOW.day)).toBe('Сегодня, 18:30');
    expect(dueText({ due: '2026-10-17', dueTime: null }, NOW.day)).toBe('Завтра');
  });

  it('declines minutes, hours and days', () => {
    expect([1, 2, 5, 11, 21, 24, 112].map((n) => plural(n, 'минуту', 'минуты', 'минут'))).toEqual([
      'минуту',
      'минуты',
      'минут',
      'минут',
      'минуту',
      'минуты',
      'минут',
    ]);
    expect(remindLabel(null)).toBe('Не напоминать');
    expect(remindLabel(0)).toBe('В момент срока');
    expect(remindLabel(10)).toBe('За 10 минут');
    expect(remindLabel(45)).toBe('За 45 минут');
    expect(remindLabel(60)).toBe('За 1 час');
    expect(remindLabel(180)).toBe('За 3 часа');
    expect(remindLabel(300)).toBe('За 5 часов');
    expect(remindLabel(1440)).toBe('За 1 день');
    expect(remindLabel(2880)).toBe('За 2 дня');
  });

  it('reads the wall clock of this device', () => {
    expect(wallMoment(new Date(2026, 9, 6, 7, 5))).toEqual({ day: '2026-10-06', time: '07:05' });
  });
});

describe('shopping lists', () => {
  it('splits pasted text into items', () => {
    expect(splitLines('молоко\n  хлеб  \n\n- яйца\n* сыр\n1. чай\n2) кофе\r\nсоль')).toEqual([
      'молоко',
      'хлеб',
      'яйца',
      'сыр',
      'чай',
      'кофе',
      'соль',
    ]);
    expect(splitLines('   \n\n')).toEqual([]);
    expect(splitLines('-5 градусов')).toEqual(['-5 градусов']);
  });

  it('keeps shopping items out of «all», and shows a list on its own', () => {
    const lists = [list({ id: 'shop', kind: 'shopping' }), list({ id: 'todo', kind: 'todo' })];
    const tasks = [
      task({ title: 'молоко', listId: 'shop' }),
      task({ title: 'починить кран', listId: 'todo' }),
      task({ title: 'позвонить' }),
    ];
    expect(tasksOfView(tasks, lists, null).map((t) => t.title)).toEqual(['починить кран', 'позвонить']);
    expect(tasksOfView(tasks, lists, 'shop').map((t) => t.title)).toEqual(['молоко']);
    expect(tasksOfView(tasks, lists, 'missing')).toEqual([]);
  });
});

describe('«Дела на сегодня»', () => {
  it('shows open tasks due today or earlier that are for this person or for nobody in particular', () => {
    const tasks = [
      task({ title: 'завтра', due: '2026-10-17' }),
      task({ title: 'сегодня, вечером', due: '2026-10-16', dueTime: '20:00' }),
      task({ title: 'сегодня', due: '2026-10-16' }),
      task({ title: 'вчера', due: '2026-10-15' }),
      task({ title: 'сделано', due: '2026-10-16', done: true }),
      task({ title: 'мне', due: '2026-10-16', assignee: 'son' }),
      task({ title: 'другому', due: '2026-10-16', assignee: 'mama' }),
      task({ title: 'без срока' }),
      task({ title: 'часом раньше', due: '2026-10-16', dueTime: '13:00' }),
    ];
    expect(tasksForToday(tasks, 'son', NOW).map((t) => t.title)).toEqual([
      'вчера',
      'часом раньше',
      'мне',
      'сегодня',
      'сегодня, вечером',
    ]);
  });
});
