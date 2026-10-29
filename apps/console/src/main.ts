import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { onlineManager, VueQueryPlugin } from '@tanstack/vue-query';
import { queryClient } from '@/lib/query';
import { onUnauthorized } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { hasUnsavedChanges } from '@/composables/useDirtyForm';
import { creationNavigationLocked } from '@/composables/useCreationDialogState';
import { projectCreationNavigationLocked } from '@/composables/useProjectCreationState';
import { router } from './router';
import App from './App.vue';
import './styles.css';

const app = createApp(App);
if (!navigator.onLine) onlineManager.setOnline(false);
app.use(createPinia());
app.use(VueQueryPlugin, { queryClient });
app.use(router);
onUnauthorized(() => {
  const auth = useAuthStore();
  if (!auth.user) return;
  const returnTo = router.currentRoute.value.fullPath;
  auth.clear();
  void router.replace({ name: 'login', query: { returnTo, expired: '1' } });
});
window.addEventListener('beforeunload', (event) => {
  if (
    hasUnsavedChanges() ||
    creationNavigationLocked.value ||
    projectCreationNavigationLocked.value
  ) {
    event.preventDefault();
    event.returnValue = '';
  }
});
app.mount('#app');
