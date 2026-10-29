import {
  computed,
  onScopeDispose,
  ref,
  type MaybeRefOrGetter,
  toValue,
  type ComputedRef,
} from 'vue';

const dirtyForms = new Map<
  symbol,
  { label: string; dirty: ComputedRef<boolean>; discard: () => void }
>();
export function useDirtyForm(value: MaybeRefOrGetter<unknown>, label = '表单') {
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
  dirtyForms.set(key, { label, dirty, discard });
  onScopeDispose(() => dirtyForms.delete(key));
  function markClean() {
    baseline.value = JSON.stringify(toValue(value));
  }
  function abandon() {
    enabled.value = false;
  }
  return { dirty, markClean, abandon, discard };
}
export function hasUnsavedChanges() {
  return [...dirtyForms.values()].some((form) => form.dirty.value);
}
export function unsavedLabels() {
  return [...dirtyForms.values()]
    .filter((form) => form.dirty.value)
    .map((form) => form.label)
    .join('、');
}
export function discardUnsavedChanges() {
  for (const form of dirtyForms.values()) if (form.dirty.value) form.discard();
}
