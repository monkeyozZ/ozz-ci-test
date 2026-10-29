import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

type Theme = 'light' | 'dark' | 'system';
interface Confirmation {
  title: string;
  description: string;
  confirmText?: string;
  destructive?: boolean;
}
export const useUiStore = defineStore('ui', () => {
  const theme = ref<Theme>('light');
  try {
    const saved = localStorage.getItem('ozz.appearance');
    if (saved === 'dark' || saved === 'system') theme.value = saved;
  } catch {
    /* Preference storage is optional. */
  }
  const media = matchMedia('(prefers-color-scheme: dark)');
  let themeFrame: number | undefined;
  function applyTheme() {
    const dark = theme.value === 'dark' || (theme.value === 'system' && media.matches);
    const root = document.documentElement;
    const changed = root.classList.contains('dark') !== dark;
    if (changed) {
      if (themeFrame !== undefined) cancelAnimationFrame(themeFrame);
      root.classList.add('theme-switching');
    }
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
    if (changed) {
      // Commit the new text and surface colors together. Interpolating a dark
      // button's foreground and background can briefly erase their contrast.
      void root.offsetWidth;
      themeFrame = requestAnimationFrame(() => {
        root.classList.remove('theme-switching');
        themeFrame = undefined;
      });
    }
    try {
      localStorage.setItem('ozz.appearance', theme.value);
    } catch {
      /* Keep the current session preference. */
    }
  }
  watch(theme, applyTheme, { immediate: true });
  media.addEventListener('change', applyTheme);
  const navigationOpen = ref(false);
  const commandOpen = ref(false);
  const confirmation = ref<Confirmation | null>(null);
  let resolveConfirmation: ((result: boolean) => void) | undefined;
  function confirm(options: Confirmation) {
    resolveConfirmation?.(false);
    confirmation.value = options;
    return new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
  }
  function settleConfirmation(result: boolean) {
    const resolve = resolveConfirmation;
    confirmation.value = null;
    resolveConfirmation = undefined;
    resolve?.(result);
  }
  const notices = ref<{ id: number; message: string; tone: 'success' | 'error' }[]>([]);
  let noticeId = 0;
  function toast(message: string, tone: 'success' | 'error' = 'success') {
    const id = ++noticeId;
    notices.value.push({ id, message, tone });
    window.setTimeout(() => dismiss(id), 6500);
  }
  function dismiss(id: number) {
    notices.value = notices.value.filter((item) => item.id !== id);
  }
  function resetSession() {
    settleConfirmation(false);
    navigationOpen.value = false;
    commandOpen.value = false;
    notices.value = [];
  }
  return {
    theme,
    navigationOpen,
    commandOpen,
    confirmation,
    confirm,
    settleConfirmation,
    notices,
    toast,
    dismiss,
    resetSession,
  };
});
