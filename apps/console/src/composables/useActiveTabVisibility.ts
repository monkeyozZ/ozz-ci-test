import { ref, toValue, watch, type MaybeRefOrGetter } from 'vue';

/** Keep the selected horizontal tab visible without moving focus or the vertical viewport. */
export function useActiveTabVisibility(selected: MaybeRefOrGetter<unknown>) {
  const navigation = ref<HTMLElement>();
  watch(
    [() => toValue(selected), navigation],
    ([_selected, element], _previous, onCleanup) => {
      if (!element) return;
      const reveal = () => {
        const tab = element.querySelector<HTMLElement>('[aria-current="page"]');
        if (!tab) return;
        const bounds = element.getBoundingClientRect();
        const activeBounds = tab.getBoundingClientRect();
        const left = bounds.left + element.clientLeft;
        const right = left + element.clientWidth;
        const delta =
          activeBounds.left < left
            ? activeBounds.left - left
            : activeBounds.right > right
              ? activeBounds.right - right
              : 0;
        if (Math.abs(delta) > 1) element.scrollBy({ left: delta, behavior: 'instant' });
      };
      reveal();
      const observer = new ResizeObserver(reveal);
      observer.observe(element);
      onCleanup(() => observer.disconnect());
    },
    { flush: 'post' },
  );
  return navigation;
}
