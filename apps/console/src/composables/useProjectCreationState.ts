import { computed, onScopeDispose, reactive, toValue, watch, type MaybeRefOrGetter } from 'vue';

const requests = reactive(new Map<symbol, { pending: boolean; uncertain: boolean }>());
export const projectCreationNavigationLocked = computed(() => requests.size > 0);
export const projectCreationLockMessage = computed(() =>
  [...requests.values()].some((request) => request.uncertain)
    ? '项目创建结果尚未确认，请先重试确认同一次创建。'
    : '项目正在创建，请等待结果后继续。',
);

/** Keep all navigation paths on the same request until its result is known. */
export function useProjectCreationState(
  pending: MaybeRefOrGetter<boolean>,
  uncertain: MaybeRefOrGetter<boolean>,
) {
  const key = Symbol('project-creation');
  watch(
    () => ({ pending: toValue(pending), uncertain: toValue(uncertain) }),
    (state) => {
      if (state.pending || state.uncertain) requests.set(key, state);
      else requests.delete(key);
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => requests.delete(key));
}
