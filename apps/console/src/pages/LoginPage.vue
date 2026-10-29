<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Eye, EyeOff, ArrowRight, ShieldCheck, AlertCircle, LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ThemeSwitcher from '@/components/ThemeSwitcher.vue';
import MutationError from '@/components/MutationError.vue';
import { useAuthStore } from '@/stores/auth';
import { safeReturnPath } from '@/lib/utils';
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const username = ref('');
const password = ref('');
const visible = ref(false);
const pending = ref(false);
const error = ref<unknown>(null);
const returnTo = computed(() => safeReturnPath(route.query.returnTo));
async function submit() {
  if (pending.value) return;
  pending.value = true;
  error.value = null;
  try {
    await auth.login(username.value.trim(), password.value);
    password.value = '';
    await router.replace(returnTo.value);
  } catch (failure) {
    error.value = failure;
    password.value = '';
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <div class="login-page">
    <header class="login-header">
      <span class="login-brand"><span class="login-mark">o</span>Ozz</span><ThemeSwitcher />
    </header>
    <main class="login-main">
      <div class="login-intro">
        <div class="login-glyph"><ShieldCheck /></div>
        <h1>进入你的工作台</h1>
        <p>项目、环境与基础设施，始终井然有序。</p>
      </div>
      <form class="login-form" @submit.prevent="submit">
        <div v-if="route.query.expired" class="notice notice-warning" role="status">
          <AlertCircle />
          <p>会话已过期。重新登录后返回原页面，未确认的操作需要重新审阅。</p>
        </div>
        <MutationError :error="error ?? auth.initializationError" />
        <div class="field">
          <label for="login-username">管理员账号</label
          ><Input
            id="login-username"
            v-model="username"
            name="username"
            autocomplete="username"
            required
            maxlength="100"
            autofocus
            :disabled="pending"
          />
        </div>
        <div class="field">
          <label for="login-password">密码</label>
          <div class="relative">
            <Input
              id="login-password"
              v-model="password"
              :type="visible ? 'text' : 'password'"
              name="password"
              autocomplete="current-password"
              required
              class="pr-12"
              :disabled="pending"
            /><Button
              type="button"
              variant="ghost"
              size="icon"
              class="absolute right-0 top-0"
              :aria-label="visible ? '隐藏密码' : '显示密码'"
              :aria-pressed="visible"
              @click="visible = !visible"
              ><component :is="visible ? EyeOff : Eye"
            /></Button>
          </div>
        </div>
        <Button type="submit" size="lg" class="w-full" :disabled="pending"
          ><LoaderCircle v-if="pending" class="animate-spin" />{{
            pending ? '正在登录…' : '登录工作台'
          }}<ArrowRight v-if="!pending"
        /></Button>
        <p class="meta text-center">仅允许已初始化的管理员登录。</p>
      </form>
      <details class="initialization-note">
        <summary>首次安装与初始化说明</summary>
        <p>
          在控制面服务器通过管理员初始化命令创建账号，然后使用该账号登录。初始化凭证由你自行设置，此页面不提供公开注册。
        </p>
      </details>
    </main>
    <footer class="login-footer">Ozz · 个人 PaaS 工作台</footer>
  </div>
</template>
<style scoped>
.login-page {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--background);
}
.login-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem 2rem;
}
.login-brand {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  font-size: 1.25rem;
  font-weight: 650;
  letter-spacing: -0.04em;
}
.login-mark {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 0.625rem;
  background: var(--primary);
  color: var(--primary-foreground);
  font-weight: 500;
}
.login-main {
  width: min(26rem, calc(100% - 2rem));
  margin: auto;
  padding: 2rem 0 4rem;
}
.login-intro {
  margin-bottom: 2rem;
}
.login-glyph {
  color: var(--primary);
  background: var(--accent);
  width: 3rem;
  height: 3rem;
  display: grid;
  place-items: center;
  border-radius: 0.875rem;
  margin-bottom: 1.5rem;
}
.login-intro h1 {
  font-size: 1.75rem;
}
.login-intro p {
  color: var(--muted-foreground);
  margin-top: 0.625rem;
}
.login-form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1.75rem;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 0.875rem;
  box-shadow: 0 2px 6px oklch(24% 0.02 285 / 0.025);
}
.initialization-note {
  margin-top: 1.5rem;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
}
.initialization-note summary {
  cursor: pointer;
  width: fit-content;
  margin: 0 auto;
  padding: 0.375rem;
}
.initialization-note p {
  margin-top: 0.75rem;
  line-height: 1.8;
}
.login-footer {
  text-align: center;
  color: var(--muted-foreground);
  font-size: 0.75rem;
  padding: 1.5rem;
}
@media (max-width: 639px) {
  .login-header {
    padding: 1rem;
  }
  .login-main {
    padding-top: 2rem;
  }
  .login-form {
    padding: 1.5rem 1.125rem;
  }
}
</style>
