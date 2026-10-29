import {
  computed,
  getCurrentInstance,
  inject,
  onScopeDispose,
  ref,
  type MaybeRefOrGetter,
  toValue,
  type ComputedRef,
  type InjectionKey,
} from 'vue';

export const DIRTY_FORM_SCOPE: InjectionKey<string> = Symbol('dirty-form-scope');
const dirtyForms = new Map<
  symbol,
  { label: string; scope: string; dirty: ComputedRef<boolean>; discard: () => void }
>();
export function useDirtyForm(value: MaybeRefOrGetter<unknown>, label = '表单') {
  const scope = getCurrentInstance() ? inject(DIRTY_FORM_SCOPE, 'page') : 'page';
  const baseline = ref(JSON.stringify(toValue(value)));
  const enabled = ref(true);
  const dirty = computed(() => enabled.value && JSON.stringify(toValue(value)) !== baseline.value);
  const key = Symbol(label);
  function discard() {
    const current = toValue(value);
    const original: unknown = baseline.value === undefined ? undefined : JSON.parse(baseline.value);
    if (current && typeof current === 'object' && original && typeof original === 'object') {
      Object.assign(current, original);
    }
    markClean();
  }
  dirtyForms.set(key, { label, scope, dirty, discard });
  onScopeDispose(() => dirtyForms.delete(key));
  function markClean() {
    baseline.value = JSON.stringify(toValue(value));
  }
  function abandon() {
    enabled.value = false;
  }
  return { dirty, markClean, abandon, discard };
}
export function hasUnsavedChanges(scope?: string) {
  return [...dirtyForms.values()].some(
    (form) => (!scope || form.scope === scope) && form.dirty.value,
  );
}
export function unsavedLabels(scope?: string) {
  return [...dirtyForms.values()]
    .filter((form) => (!scope || form.scope === scope) && form.dirty.value)
    .map((form) => form.label)
    .join('、');
}
export function discardUnsavedChanges(scope?: string) {
  for (const form of dirtyForms.values())
    if ((!scope || form.scope === scope) && form.dirty.value) form.discard();
}
