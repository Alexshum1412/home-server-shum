/** What a person tells about themselves: it makes the digest and the bot fit them. */
export interface InterestDef {
  id: string;
  title: string;
  lead: string;
}

export const INTERESTS: readonly InterestDef[] = [
  {
    id: 'german',
    title: 'Учу немецкий',
    lead: 'Каждое утро — слово дня на немецком с переводом и примером.',
  },
  {
    id: 'english',
    title: 'Учу английский',
    lead: 'Каждое утро — слово дня на английском с переводом и примером.',
  },
  { id: 'news', title: 'Новости', lead: 'Три главных заголовка Би-би-си на русском.' },
  { id: 'recipes', title: 'Идеи для кухни', lead: 'Идея, что приготовить сегодня.' },
];

export interface ProfileView {
  city: string;
  hasCoordinates: boolean;
  /** The name in Telegram that the person gave (@name), only to show. */
  telegramUsername: string;
  /** The bot knows this person (they linked the chat). */
  telegramLinked: boolean;
  /** The notifications of the portal are also sent to the linked Telegram chat. */
  telegramNotify: boolean;
  interests: string[];
  /** Anything else the person is into, in their words (the model sees it when it writes the digest). */
  about: string;
  /** The first-sign-in questions were answered or skipped. */
  onboarded: boolean;
}

export interface ProfileResponse {
  profile: ProfileView;
  interests: readonly InterestDef[];
  /** The Telegram bot of the family (its name), or null when it is not connected. */
  bot: string | null;
}

export interface ProfilePatch {
  city?: string;
  telegramUsername?: string;
  telegramNotify?: boolean;
  interests?: string[];
  about?: string;
  onboarded?: boolean;
}

export interface TelegramLinkResponse {
  code: string;
  bot: string;
  expiresInMinutes: number;
}
