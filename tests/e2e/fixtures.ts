// Test-only accounts for the isolated e2e servers. These exist only in throwaway
// temp data directories created by start-server.mjs and are never used for real data.
export const E2E_USERS = {
  admin: {
    username: 'e2e-admin',
    password: 'e2e-admin-password-1',
    displayName: 'Тестовый админ',
    role: 'admin',
  },
  family: {
    username: 'e2e-family',
    password: 'e2e-family-password-1',
    displayName: 'Тестовая семья',
    role: 'family',
  },
  /** Seeded with mustChangePassword: true, like an account made with --generate-password. */
  temporary: {
    username: 'e2e-temp',
    password: 'e2e-temp-password-1',
    displayName: 'Новичок',
    role: 'family',
  },
  /** Changes its own password in «Мой профиль» (used by exactly one test). */
  changer: {
    username: 'e2e-change',
    password: 'e2e-change-password-1',
    displayName: 'Меняющий',
    role: 'family',
  },
  /** A third person for the chat and call tests. */
  chatter: {
    username: 'e2e-chat',
    password: 'e2e-chat-password-1',
    displayName: 'Собеседник',
    role: 'family',
  },
  /** The two people of the call tests (nobody else uses them). */
  caller: {
    username: 'e2e-caller',
    password: 'e2e-caller-password-1',
    displayName: 'Звонящий',
    role: 'family',
  },
  callee: {
    username: 'e2e-callee',
    password: 'e2e-callee-password-1',
    displayName: 'Отвечающий',
    role: 'family',
  },
} as const;

export type E2EUserKey = keyof typeof E2E_USERS;

export const VIEWPORTS = [375, 390, 430, 768, 1024, 1440] as const;
