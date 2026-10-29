import { onScopeDispose, readonly, ref } from 'vue';

const now = ref(Date.now());
let consumers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const update = () => {
  now.value = Date.now();
};

/** One clock for all visible observations; no per-row timers survive navigation. */
export function useObservationClock() {
  update();
  consumers++;
  if (!timer) {
    timer = setInterval(update, 15_000);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
  }
  onScopeDispose(() => {
    consumers--;
    if (consumers === 0) {
      clearInterval(timer);
      timer = undefined;
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
    }
  });
  return readonly(now);
}
