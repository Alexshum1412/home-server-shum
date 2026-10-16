/** Greeting by local hour: 5–11 morning, 12–16 day, 17–22 evening, 23–4 night. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour <= 11) return 'Доброе утро';
  if (hour >= 12 && hour <= 16) return 'Добрый день';
  if (hour >= 17 && hour <= 22) return 'Добрый вечер';
  return 'Доброй ночи';
}

/** «Добрый вечер, Мама». */
export function greetingLine(hour: number, displayName: string | null | undefined): string {
  const name = displayName?.trim();
  return name ? `${greetingFor(hour)}, ${name}` : greetingFor(hour);
}
