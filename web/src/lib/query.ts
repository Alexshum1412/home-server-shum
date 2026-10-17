/** Reading and building the query string of a page (folder, space, month live in the address). */

export function readParam(search: string, name: string): string {
  return new URLSearchParams(search).get(name) ?? '';
}

/** "/files" + {space: 'shared', path: ''} → "/files?space=shared"; empty values are left out. */
export function withQuery(pathname: string, params: Record<string, string>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== '') query.set(name, value);
  }
  const text = query.toString();
  return text === '' ? pathname : `${pathname}?${text}`;
}

/** Joins a folder path and a name with a forward slash ('' + 'a' → 'a'). */
export function joinPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`;
}
