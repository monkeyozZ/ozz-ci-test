import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

/** Non-secret list filters stay in their URL across refresh and browser navigation. */
export function useRouteFilter(name: string) {
  const route = useRoute();
  const router = useRouter();
  return computed({
    get: () => (typeof route.query[name] === 'string' ? (route.query[name] as string) : ''),
    set: (value: string) => {
      void router.replace({
        path: route.path,
        query: { ...route.query, [name]: value || undefined },
      });
    },
  });
}
