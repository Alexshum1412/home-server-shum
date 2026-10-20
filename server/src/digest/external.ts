/**
 * Two public pieces of information for the morning digest: the weather (Open-Meteo, free, no key; only the coordinates of
 * the city go out) and the exchange rates of the Bank of Russia (a public daily file). No family data leaves the house.
 * Both return null on any failure: a digest without them is still a digest.
 */
type Fetch = typeof fetch;

const WEATHER_WORDS: Array<[number[], string]> = [
  [[0], 'ясно'],
  [[1, 2], 'малооблачно'],
  [[3], 'пасмурно'],
  [[45, 48], 'туман'],
  [[51, 53, 55, 56, 57], 'морось'],
  [[61, 63, 65, 66, 67], 'дождь'],
  [[71, 73, 75, 77], 'снег'],
  [[80, 81, 82], 'ливень'],
  [[85, 86], 'снегопад'],
  [[95, 96, 99], 'гроза'],
];

export const weatherWord = (code: number): string =>
  WEATHER_WORDS.find(([codes]) => codes.includes(code))?.[1] ?? 'переменная погода';

async function getJson(fetchImpl: Fetch, url: string, ms: number): Promise<unknown> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(ms),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function geocode(
  city: string,
  fetchImpl: Fetch = fetch,
): Promise<{ name: string; latitude: number; longitude: number } | null> {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru&format=json`;
    const body = (await getJson(fetchImpl, url, 8000)) as {
      results?: Array<{ name: string; latitude: number; longitude: number }>;
    };
    const first = body.results?.[0];
    return first && Number.isFinite(first.latitude) && Number.isFinite(first.longitude)
      ? { name: first.name, latitude: first.latitude, longitude: first.longitude }
      : null;
  } catch {
    return null;
  }
}

export async function weatherToday(
  latitude: number,
  longitude: number,
  fetchImpl: Fetch = fetch,
): Promise<string | null> {
  try {
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${latitude.toFixed(3)}&longitude=${longitude.toFixed(3)}` +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1';
    const body = (await getJson(fetchImpl, url, 8000)) as {
      daily?: {
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_probability_max?: Array<number | null>;
      };
    };
    const d = body.daily;
    const code = d?.weather_code?.[0];
    const max = d?.temperature_2m_max?.[0];
    const min = d?.temperature_2m_min?.[0];
    if (code === undefined || max === undefined || min === undefined) return null;
    const rain = d?.precipitation_probability_max?.[0];
    const round = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n)}`;
    return `${weatherWord(code)}, от ${round(min)} до ${round(max)} °C${typeof rain === 'number' && rain >= 30 ? `, вероятность осадков ${Math.round(rain)} %` : ''}`;
  } catch {
    return null;
  }
}

export async function currencyToday(fetchImpl: Fetch = fetch): Promise<string | null> {
  try {
    const body = (await getJson(fetchImpl, 'https://www.cbr-xml-daily.ru/daily_json.js', 8000)) as {
      Valute?: Record<string, { Value: number; Previous: number; Nominal: number }>;
    };
    const parts: string[] = [];
    for (const [code, label] of [
      ['USD', 'доллар'],
      ['EUR', 'евро'],
      ['CNY', 'юань'],
    ] as const) {
      const v = body.Valute?.[code];
      if (!v || !Number.isFinite(v.Value)) continue;
      const each = v.Value / (v.Nominal || 1);
      const diff = each - v.Previous / (v.Nominal || 1);
      parts.push(
        `${label} ${each.toFixed(2).replace('.', ',')} ₽${Math.abs(diff) >= 0.01 ? ` (${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(2).replace('.', ',')})` : ''}`,
      );
    }
    return parts.length > 0 ? parts.join(', ') : null;
  } catch {
    return null;
  }
}
