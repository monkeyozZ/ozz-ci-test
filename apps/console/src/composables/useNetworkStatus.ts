import { onlineManager } from '@tanstack/vue-query';
import { onScopeDispose, shallowRef } from 'vue';

/** Share the same connection state as paused queries, without creating extra window listeners. */
export function useNetworkStatus() {
  const online = shallowRef(onlineManager.isOnline());
  const unsubscribe = onlineManager.subscribe((value) => {
    online.value = value;
  });
  onScopeDispose(unsubscribe);
  return online;
}
