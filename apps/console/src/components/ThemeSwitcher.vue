<script setup lang="ts">
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItemIndicator,
  DropdownMenuLabel,
} from 'reka-ui';
import { Sun, Moon, Monitor, Check } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useUiStore } from '@/stores/ui';
const ui = useUiStore();
const choices = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const;
</script>
<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger as-child
      ><Button variant="ghost" size="icon" aria-label="选择外观主题"
        ><component
          :is="ui.theme === 'dark' ? Moon : ui.theme === 'system' ? Monitor : Sun" /></Button
    ></DropdownMenuTrigger>
    <DropdownMenuPortal
      ><DropdownMenuContent class="theme-menu" :side-offset="8" align="end">
        <DropdownMenuLabel class="meta px-2 py-1.5">外观</DropdownMenuLabel>
        <DropdownMenuRadioGroup v-model="ui.theme"
          ><DropdownMenuRadioItem
            v-for="choice in choices"
            :key="choice.value"
            :value="choice.value"
            class="theme-choice"
            ><component :is="choice.icon" class="size-4" /><span class="flex-1">{{
              choice.label
            }}</span
            ><DropdownMenuItemIndicator
              ><Check
                class="size-4 text-primary" /></DropdownMenuItemIndicator></DropdownMenuRadioItem
        ></DropdownMenuRadioGroup> </DropdownMenuContent
    ></DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
<style scoped>
.theme-menu {
  z-index: 200;
  min-width: 11rem;
  background: var(--card);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  border-radius: 0.625rem;
  padding: 0.375rem;
}
.theme-choice {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.5rem;
  border-radius: 0.375rem;
  cursor: pointer;
  outline-offset: -2px;
}
.theme-choice[data-highlighted] {
  background: var(--accent);
}
</style>
