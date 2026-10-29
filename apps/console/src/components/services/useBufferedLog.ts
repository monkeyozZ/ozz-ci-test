import { nextTick, onScopeDispose, ref } from 'vue';

/** Search only the retained buffer, with literal, case-insensitive matching. */
export function matchesLogSearch(value: string, search: string) {
  return !search || value.toLocaleLowerCase().includes(search.toLocaleLowerCase());
}

export function bufferedLogLines(text: string, firstLine: number, search: string) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines
    .map((value, index) => ({ key: firstLine + index, text: value }))
    .filter((line) => matchesLogSearch(line.text, search));
}

/** Keep append handling separate from the explicit "return to latest" action. */
export function useLogViewport() {
  const output = ref<HTMLElement>();
  const following = ref(true);
  const unread = ref(0);
  let active = true;
  let positioning = false;
  let frame = 0;

  function pause() {
    following.value = false;
    positioning = false;
    cancelAnimationFrame(frame);
  }
  async function followLatest() {
    if (!following.value) return;
    positioning = true;
    cancelAnimationFrame(frame);
    await nextTick();
    // A wheel/key event can pause while Vue is rendering the appended output.
    if (!active || !following.value) {
      positioning = false;
      return;
    }
    if (output.value) output.value.scrollTop = output.value.scrollHeight;
    frame = requestAnimationFrame(() => {
      positioning = false;
    });
  }
  async function jumpToLatest() {
    following.value = true;
    unread.value = 0;
    await followLatest();
  }
  function appended(count: number) {
    if (following.value) void followLatest();
    else unread.value = Math.min(9999, unread.value + count);
  }
  function onScroll() {
    if (!output.value || positioning) return;
    if (output.value.scrollHeight - output.value.scrollTop - output.value.clientHeight >= 40)
      pause();
  }
  function onWheel(event: WheelEvent) {
    if (event.deltaY < 0) pause();
  }
  function onHistoryKey(event: KeyboardEvent) {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pause();
  }
  function reset() {
    following.value = true;
    unread.value = 0;
  }
  onScopeDispose(() => {
    active = false;
    cancelAnimationFrame(frame);
  });
  return {
    output,
    following,
    unread,
    pause,
    jumpToLatest,
    appended,
    onScroll,
    onWheel,
    onHistoryKey,
    reset,
  };
}
