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
} as const;

export type E2EUserKey = keyof typeof E2E_USERS;

export const VIEWPORTS = [375, 390, 430, 768, 1024, 1440] as const;
