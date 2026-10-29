import { defineStore } from 'pinia';
import { ref } from 'vue';
import { ApiError, request, setCsrfToken } from '@/lib/api';
import { queryClient } from '@/lib/query';
import type { Envelope, Session, User } from '@/lib/types';
import { useUiStore } from './ui';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const ready = ref(false);
  const restoreMode = ref(false);
  const checking = ref(false);
  const initializationError = ref<unknown>(null);
  let currentCheck: Promise<void> | null = null;
  function establish(session: Session) {
    user.value = session.user;
    restoreMode.value = session.restoreMode;
    setCsrfToken(session.csrfToken);
    ready.value = true;
    initializationError.value = null;
  }
  function clear() {
    useUiStore().resetSession();
    user.value = null;
    setCsrfToken(null);
    void queryClient.cancelQueries();
    queryClient.clear();
  }
  async function refresh() {
    if (currentCheck) return currentCheck;
    checking.value = true;
    currentCheck = (async () => {
      try {
        establish((await request<Envelope<Session>>('/auth/me', { auth: false })).data);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (error instanceof ApiError && error.status === 401) {
          clear();
          initializationError.value = null;
        } else initializationError.value = error;
      } finally {
        ready.value = true;
        checking.value = false;
        currentCheck = null;
      }
    })();
    return currentCheck;
  }
  async function login(username: string, password: string) {
    const result = await request<Envelope<Session>>('/auth/login', {
      method: 'POST',
      body: { username, password },
      auth: false,
    });
    establish(result.data);
  }
  async function logout() {
    await request('/auth/logout', { method: 'POST' });
    clear();
  }
  return { user, ready, restoreMode, checking, initializationError, refresh, login, logout, clear };
});
