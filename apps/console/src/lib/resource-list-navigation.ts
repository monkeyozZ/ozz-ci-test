type ResourceList = 'infrastructure' | 'volumes' | 'databases';
const filters: Record<ResourceList, readonly string[]> = {
  infrastructure: ['tab', 'search'],
  volumes: ['projectId', 'environmentId', 'clusterId', 'serviceId', 'retained', 'search'],
  databases: ['projectId', 'environmentId', 'clusterId', 'serviceId', 'search'],
};
const origin = 'https://ozz.invalid';

/** Carry only the corresponding list and its non-secret filters through a detail page. */
export function resourceListPath(value: unknown, resource: ResourceList): string | undefined {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return undefined;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin || url.pathname !== '/' + resource) return undefined;
  const query = new URLSearchParams();
  for (const key of filters[resource]) {
    const values = url.searchParams.getAll(key);
    if (values.length > 1) return undefined;
    if (values[0]) query.set(key, values[0]);
  }
  return url.pathname + (query.size ? '?' + query.toString() : '');
}

export function resourceDetailLocation(path: string, listPath: unknown, resource: ResourceList) {
  const list = resourceListPath(listPath, resource);
  return list ? { path, query: { list } } : { path };
}
