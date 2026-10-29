import { onScopeDispose } from 'vue';

/** A completed write may update shared queries, but must not navigate a view the user has left. */
export function useViewScope() {
  let active = true;
  onScopeDispose(() => {
    active = false;
  });
  return () => active;
}
