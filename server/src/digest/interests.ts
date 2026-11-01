/**
 * What the digest adds for a person's interests: a word of the day in German or English (a fixed list, one word per day,
 * so it is always correct), an idea for the kitchen, and the day's main headlines of the BBC in Russian.
 */
type Word = [word: string, translation: string, example: string, exampleRu: string];

const GERMAN: Word[] = [
  ['das Haus', 'дом', 'Das Haus ist groß.', 'Дом большой.'],
  ['der Tisch', 'стол', 'Der Tisch ist aus Holz.', 'Стол деревянный.'],
  ['die Katze', 'кошка', 'Die Katze schläft auf dem Sofa.', 'Кошка спит на диване.'],
  ['der Hund', 'собака', 'Der Hund spielt im Garten.', 'Собака играет в саду.'],
  ['das Wasser', 'вода', 'Ich trinke Wasser.', 'Я пью воду.'],
  ['das Brot', 'хлеб', 'Ich esse Brot mit Butter.', 'Я ем хлеб с маслом.'],
  ['die Milch', 'молоко', 'Die Milch ist kalt.', 'Молоко холодное.'],
  ['der Apfel', 'яблоко', 'Der Apfel ist rot.', 'Яблоко красное.'],
  ['die Schule', 'школа', 'Die Kinder gehen in die Schule.', 'Дети идут в школу.'],
  ['das Buch', 'книга', 'Ich lese ein Buch.', 'Я читаю книгу.'],
  ['der Freund', 'друг', 'Mein Freund wohnt in Berlin.', 'Мой друг живёт в Берлине.'],
  ['die Familie', 'семья', 'Meine Familie ist groß.', 'Моя семья большая.'],
  ['die Arbeit', 'работа', 'Die Arbeit beginnt um acht Uhr.', 'Работа начинается в восемь часов.'],
  ['das Auto', 'машина', 'Das Auto ist neu.', 'Машина новая.'],
  ['der Zug', 'поезд', 'Der Zug kommt um zehn Uhr.', 'Поезд приходит в десять часов.'],
  ['die Straße', 'улица', 'Die Straße ist lang.', 'Улица длинная.'],
  ['die Stadt', 'город', 'Die Stadt ist schön.', 'Город красивый.'],
  ['das Wetter', 'погода', 'Das Wetter ist heute gut.', 'Сегодня хорошая погода.'],
  ['der Regen', 'дождь', 'Der Regen hört bald auf.', 'Дождь скоро закончится.'],
  ['die Sonne', 'солнце', 'Die Sonne scheint.', 'Светит солнце.'],
  ['der Morgen', 'утро', 'Guten Morgen!', 'Доброе утро!'],
  ['der Abend', 'вечер', 'Am Abend sehen wir einen Film.', 'Вечером мы смотрим фильм.'],
  ['die Nacht', 'ночь', 'Gute Nacht!', 'Спокойной ночи!'],
  ['heute', 'сегодня', 'Heute ist Montag.', 'Сегодня понедельник.'],
  ['morgen', 'завтра', 'Morgen fahre ich nach Hause.', 'Завтра я еду домой.'],
  ['gestern', 'вчера', 'Gestern war es kalt.', 'Вчера было холодно.'],
  ['essen', 'есть, кушать', 'Wir essen um sieben Uhr.', 'Мы ужинаем в семь часов.'],
  ['trinken', 'пить', 'Er trinkt Tee.', 'Он пьёт чай.'],
  ['gehen', 'идти', 'Ich gehe nach Hause.', 'Я иду домой.'],
  ['kommen', 'приходить', 'Kommst du morgen?', 'Ты придёшь завтра?'],
  ['machen', 'делать', 'Was machst du?', 'Что ты делаешь?'],
  ['sprechen', 'говорить', 'Sie spricht Deutsch.', 'Она говорит по-немецки.'],
  ['lernen', 'учить', 'Ich lerne jeden Tag Deutsch.', 'Я учу немецкий каждый день.'],
  ['verstehen', 'понимать', 'Ich verstehe dich nicht.', 'Я тебя не понимаю.'],
  ['helfen', 'помогать', 'Kannst du mir helfen?', 'Ты можешь мне помочь?'],
  ['brauchen', 'нуждаться', 'Ich brauche Hilfe.', 'Мне нужна помощь.'],
  ['wohnen', 'жить, проживать', 'Wir wohnen in Moskau.', 'Мы живём в Москве.'],
  ['arbeiten', 'работать', 'Er arbeitet im Büro.', 'Он работает в офисе.'],
  ['spielen', 'играть', 'Die Kinder spielen draußen.', 'Дети играют на улице.'],
  ['schlafen', 'спать', 'Das Baby schläft.', 'Малыш спит.'],
  ['groß', 'большой', 'Der Hund ist groß.', 'Собака большая.'],
  ['klein', 'маленький', 'Die Katze ist klein.', 'Кошка маленькая.'],
  ['schön', 'красивый', 'Das Bild ist schön.', 'Картина красивая.'],
  ['schnell', 'быстрый', 'Der Zug ist schnell.', 'Поезд быстрый.'],
  ['langsam', 'медленный', 'Bitte sprechen Sie langsam.', 'Пожалуйста, говорите медленно.'],
  ['gut', 'хороший', 'Das Essen ist gut.', 'Еда хорошая.'],
  ['warm', 'тёплый', 'Das Zimmer ist warm.', 'В комнате тепло.'],
  ['kalt', 'холодный', 'Draußen ist es kalt.', 'На улице холодно.'],
  ['neu', 'новый', 'Ich habe ein neues Handy.', 'У меня новый телефон.'],
  ['alt', 'старый', 'Das Haus ist alt.', 'Дом старый.'],
  ['danke', 'спасибо', 'Danke für die Hilfe!', 'Спасибо за помощь!'],
  ['bitte', 'пожалуйста', 'Bitte, setzen Sie sich.', 'Пожалуйста, садитесь.'],
  ['Entschuldigung', 'извините', 'Entschuldigung, wo ist der Bahnhof?', 'Извините, где вокзал?'],
  ['der Bahnhof', 'вокзал', 'Der Bahnhof ist in der Nähe.', 'Вокзал рядом.'],
  ['das Fenster', 'окно', 'Das Fenster ist offen.', 'Окно открыто.'],
  ['die Tür', 'дверь', 'Bitte mach die Tür zu.', 'Пожалуйста, закрой дверь.'],
  ['der Schlüssel', 'ключ', 'Wo ist mein Schlüssel?', 'Где мой ключ?'],
  ['das Geld', 'деньги', 'Ich habe wenig Geld.', 'У меня мало денег.'],
  ['die Zeit', 'время', 'Ich habe keine Zeit.', 'У меня нет времени.'],
  ['das Kind', 'ребёнок', 'Das Kind lacht.', 'Ребёнок смеётся.'],
  ['die Blume', 'цветок', 'Die Blume riecht gut.', 'Цветок хорошо пахнет.'],
];

const ENGLISH: Word[] = [
  ['reliable', 'надёжный', 'This car is very reliable.', 'Эта машина очень надёжная.'],
  ['improve', 'улучшать', 'I want to improve my English.', 'Я хочу улучшить свой английский.'],
  ['although', 'хотя', 'Although it was raining, we went for a walk.', 'Хотя шёл дождь, мы пошли гулять.'],
  ['borrow', 'брать взаймы', 'Can I borrow your pen?', 'Можно взять твою ручку?'],
  ['lend', 'одалживать', 'Could you lend me some money?', 'Не могли бы вы одолжить мне денег?'],
  ['enough', 'достаточно', 'We have enough time.', 'У нас достаточно времени.'],
  ['especially', 'особенно', 'I like fruit, especially apples.', 'Я люблю фрукты, особенно яблоки.'],
  ['suggest', 'предлагать', 'I suggest we leave early.', 'Я предлагаю выйти пораньше.'],
  ['prefer', 'предпочитать', 'I prefer tea to coffee.', 'Я предпочитаю чай кофе.'],
  ['remind', 'напоминать', 'Please remind me to call Mum.', 'Пожалуйста, напомни мне позвонить маме.'],
  ['delay', 'задержка', 'There is a delay of ten minutes.', 'Задержка составляет десять минут.'],
  ['achieve', 'достигать', 'She worked hard to achieve her goal.', 'Она много работала, чтобы достичь цели.'],
  ['recipe', 'рецепт', 'This is my grandmother’s recipe.', 'Это рецепт моей бабушки.'],
  ['neighbour', 'сосед', 'Our neighbour is very kind.', 'Наш сосед очень добрый.'],
  ['receive', 'получать', 'I received your message yesterday.', 'Я получил твоё сообщение вчера.'],
  ['invite', 'приглашать', 'They invited us to dinner.', 'Они пригласили нас на ужин.'],
  ['decide', 'решать', 'We decided to stay at home.', 'Мы решили остаться дома.'],
  ['manage', 'справляться', 'I can manage on my own.', 'Я справлюсь сам.'],
  ['pleasure', 'удовольствие', 'It was a pleasure to meet you.', 'Было приятно с вами познакомиться.'],
  ['luggage', 'багаж', 'My luggage is very heavy.', 'Мой багаж очень тяжёлый.'],
  ['departure', 'отправление', 'The departure is at six o’clock.', 'Отправление в шесть часов.'],
  ['arrive', 'прибывать', 'We arrive at noon.', 'Мы прибываем в полдень.'],
  ['afford', 'позволить себе', 'I can’t afford a new phone.', 'Я не могу позволить себе новый телефон.'],
  ['gift', 'подарок', 'She gave me a lovely gift.', 'Она подарила мне чудесный подарок.'],
  ['healthy', 'здоровый', 'Eat healthy food.', 'Ешьте здоровую пищу.'],
  ['habit', 'привычка', 'Reading is a good habit.', 'Чтение — хорошая привычка.'],
  ['advice', 'совет', 'Thank you for your advice.', 'Спасибо за совет.'],
  ['mistake', 'ошибка', 'Everyone makes mistakes.', 'Все делают ошибки.'],
];

const DISHES = [
  'Сырники со сметаной',
  'Борщ',
  'Плов',
  'Омлет с помидорами',
  'Гречка с грибами',
  'Куриный суп с лапшой',
  'Оладьи',
  'Паста с томатным соусом',
  'Картофельное пюре с котлетами',
  'Рыба в духовке с овощами',
  'Салат из огурцов и помидоров',
  'Запечённая курица с картошкой',
  'Овсяная каша с яблоком',
  'Блинчики',
  'Щи',
  'Ленивые вареники',
  'Тушёная капуста с сосисками',
  'Пицца на тонком тесте',
  'Шарлотка с яблоками',
  'Рагу из овощей',
  'Макароны по-флотски',
  'Гороховый суп',
  'Запеканка из творога',
  'Куриные котлеты на пару',
  'Рис с овощами и яйцом',
  'Харчо',
  'Голубцы',
  'Пельмени с бульоном',
  'Творожное печенье',
  'Греческий салат',
];

/** Day number since 1970 of a local day «YYYY-MM-DD»: the same word for everybody on the same day, a new one the next day. */
export function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

export const wordOfDay = (list: Word[], day: string): Word => list[dayNumber(day) % list.length] as Word;

export function germanLine(day: string): string {
  const [word, ru, ex, exRu] = wordOfDay(GERMAN, day);
  return `Слово дня на немецком: ${word} — ${ru}. Пример: ${ex} (${exRu})`;
}

export function englishLine(day: string): string {
  const [word, ru, ex, exRu] = wordOfDay(ENGLISH, day);
  return `Слово дня на английском: ${word} — ${ru}. Пример: ${ex} (${exRu})`;
}

export const recipeLine = (day: string): string =>
  `Идея на сегодня: ${DISHES[dayNumber(day) % DISHES.length]}.`;

/** The first three headlines of an RSS file (BBC Russian). */
export function parseHeadlines(xml: string, limit = 3): string[] {
  const titles: string[] = [];
  for (const item of xml.split('<item>').slice(1)) {
    const match = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(item);
    const text = match?.[1]
      ?.replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    if (text) titles.push(text);
    if (titles.length >= limit) break;
  }
  return titles;
}

export async function newsLine(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl('https://feeds.bbci.co.uk/russian/rss.xml', {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const titles = parseHeadlines(await response.text());
    return titles.length > 0
      ? `Новости Би-би-си: ${titles.map((t, i) => `${i + 1}) ${t}`).join('; ')}`
      : null;
  } catch {
    return null;
  }
}
