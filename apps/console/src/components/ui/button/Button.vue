<script setup lang="ts">
import { Primitive, type PrimitiveProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';
import { buttonVariants, type ButtonVariants } from './variants';

interface Props extends PrimitiveProps {
  variant?: ButtonVariants['variant'];
  size?: ButtonVariants['size'];
  class?: HTMLAttributes['class'];
  disabled?: boolean;
}
const props = withDefaults(defineProps<Props>(), { as: 'button' });
function preventDisabledAction(event: MouseEvent) {
  if (!props.disabled) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}
</script>
<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    :disabled="!asChild && as === 'button' ? disabled : undefined"
    :aria-disabled="disabled || undefined"
    :tabindex="disabled && (asChild || as !== 'button') ? -1 : undefined"
    :class="cn(buttonVariants({ variant, size }), props.class)"
    @click.capture="preventDisabledAction"
    @auxclick.capture="preventDisabledAction"
    ><slot
  /></Primitive>
</template>
