import { onActivated, onDeactivated, onScopeDispose } from 'vue';

/** A completed write may update shared queries, but must not navigate a view the user has left. */
export function useViewScope() {
  let active = true;
  onActivated(() => {
    active = true;
  });
  onDeactivated(() => {
    active = false;
  });
  onScopeDispose(() => {
    active = false;
  });
  return () => active;
}
