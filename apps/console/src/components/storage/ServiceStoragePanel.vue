<script setup lang="ts">
import { computed } from 'vue';
import QueryState from '@/components/QueryState.vue';
import type { Service } from '@/components/services/types';
import { useCollection } from '@/lib/query';
import type { Database } from './types';
import DatabaseIdentity from './DatabaseIdentity.vue';
import ServiceVolumeMounts from './ServiceVolumeMounts.vue';
import ServiceDatabaseBindings from './ServiceDatabaseBindings.vue';
import StorageTarget from './StorageTarget.vue';
const props = defineProps<{ service: Service }>();
const databases = useCollection<Database>(
  '/databases',
  computed(() => ({ serviceId: props.service.id })),
  true,
  { refetchInterval: 15_000 },
);
const database = computed(
  () => databases.items.value.find((item) => item.service?.id === props.service.id) ?? null,
);
</script>
<template>
  <div data-service-storage-panel>
    <StorageTarget :context="service" class="mb-6" />
    <QueryState
      :pending="databases.isPending.value"
      :error="databases.error.value"
      @retry="databases.refetch()"
      ><DatabaseIdentity v-if="database" :database="database" compact class="mb-6"
    /></QueryState>
    <ServiceVolumeMounts
      :service="service"
      :database="database"
      :database-pending="databases.isPending.value || !!databases.error.value"
    />
    <ServiceDatabaseBindings
      v-if="!database && !databases.isPending.value && !databases.error.value"
      :service="service"
      class="mt-6"
    />
  </div>
</template>
