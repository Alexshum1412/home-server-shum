/**
 * Normalises the allowlisted `osVersion` script output into a readable line such as
 * "Windows 10 Home 22H2 (сборка 19045.6456)". The build number (with UBR) tells the admin
 * which cumulative update is installed. Returns null when the data is unusable.
 */
export function parseOsVersion(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const product = text(data.product);
  if (product === '') return null;
  const displayVersion = text(data.displayVersion);
  const build = text(data.build);
  const ubr = typeof data.ubr === 'number' && Number.isInteger(data.ubr) && data.ubr > 0 ? data.ubr : null;
  const name = displayVersion === '' ? product : `${product} ${displayVersion}`;
  if (build === '') return name;
  return `${name} (сборка ${ubr === null ? build : `${build}.${ubr}`})`;
}
