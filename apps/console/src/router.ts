import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import {
  hasUnsavedChanges,
  unsavedLabels,
  discardUnsavedChanges,
} from '@/composables/useDirtyForm';
import { safeReturnPath } from '@/lib/utils';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/pages/LoginPage.vue'),
      meta: { title: '管理员登录', public: true },
    },
    {
      path: '/',
      component: () => import('@/components/AppShell.vue'),
      children: [
        { path: '', redirect: '/projects' },
        {
          path: 'projects',
          component: () => import('@/pages/ProjectsPage.vue'),
          meta: { title: '项目' },
        },
        {
          path: 'projects/new',
          component: () => import('@/pages/ProjectCreatePage.vue'),
          meta: { title: '创建项目' },
        },
        {
          path: 'projects/:projectId',
          component: () => import('@/pages/ProjectPage.vue'),
          meta: { title: '项目工作区' },
        },
        {
          path: 'projects/:projectId/services/new',
          component: () => import('@/pages/ServiceCreatePage.vue'),
          meta: { title: '添加服务' },
        },
        {
          path: 'projects/:projectId/services/:serviceId',
          component: () => import('@/pages/ServicePage.vue'),
          meta: { title: '服务详情' },
        },
        {
          path: 'services',
          component: () => import('@/pages/ServicesPage.vue'),
          meta: { title: '服务' },
        },
        {
          path: 'templates',
          component: () => import('@/pages/TemplatesPage.vue'),
          meta: { title: '服务模板' },
        },
        {
          path: 'templates/:templateId',
          component: () => import('@/pages/TemplateCreatePage.vue'),
          meta: { title: '从模板添加服务' },
        },
        {
          path: 'volumes',
          component: () => import('@/pages/VolumesPage.vue'),
          meta: { title: '持久卷' },
        },
        {
          path: 'volumes/new',
          component: () => import('@/pages/VolumeCreatePage.vue'),
          meta: { title: '创建持久卷' },
        },
        {
          path: 'volumes/:volumeId',
          component: () => import('@/pages/VolumePage.vue'),
          meta: { title: '持久卷详情' },
        },
        {
          path: 'databases',
          component: () => import('@/pages/DatabasesPage.vue'),
          meta: { title: '数据库' },
        },
        {
          path: 'databases/:databaseId',
          component: () => import('@/pages/DatabasePage.vue'),
          meta: { title: '数据库详情' },
        },
        {
          path: 'domains',
          component: () => import('@/pages/DomainsPage.vue'),
          meta: { title: '域名与网络' },
        },
        {
          path: 'domains/:domainId',
          component: () => import('@/pages/DomainPage.vue'),
          meta: { title: '域名检查' },
        },
        {
          path: 'deployments',
          component: () => import('@/pages/DeploymentsPage.vue'),
          meta: { title: '部署与 Git 事件' },
        },
        {
          path: 'webhook-deliveries/:deliveryId',
          component: () => import('@/pages/WebhookDeliveryPage.vue'),
          meta: { title: 'GitHub 事件详情' },
        },
        {
          path: 'deployments/:deploymentId',
          component: () => import('@/pages/DeploymentPage.vue'),
          meta: { title: '部署记录' },
        },
        {
          path: 'infrastructure',
          component: () => import('@/pages/InfrastructurePage.vue'),
          meta: { title: '基础设施' },
        },
        {
          path: 'clusters/new',
          component: () => import('@/pages/ClusterPage.vue'),
          meta: { title: '登记集群' },
        },
        {
          path: 'clusters/:clusterId',
          component: () => import('@/pages/ClusterPage.vue'),
          meta: { title: '集群登记' },
        },
        {
          path: 'servers/new',
          component: () => import('@/pages/ServerPage.vue'),
          meta: { title: '登记服务器' },
        },
        {
          path: 'servers/:serverId',
          component: () => import('@/pages/ServerPage.vue'),
          meta: { title: '服务器登记' },
        },
        {
          path: 'settings',
          component: () => import('@/pages/SettingsPage.vue'),
          meta: { title: '设置与凭证' },
        },
        {
          path: 'operations',
          component: () => import('@/pages/OperationsPage.vue'),
          meta: { title: '操作任务' },
        },
        {
          path: 'operations/:operationId',
          component: () => import('@/pages/OperationPage.vue'),
          meta: { title: '操作任务详情' },
        },
        {
          path: ':pathMatch(.*)*',
          component: () => import('@/pages/NotFoundPage.vue'),
          meta: { title: '页面不存在' },
        },
      ],
    },
  ],
  scrollBehavior(to, from, saved) {
    if (saved) return saved;
    return to.path === from.path ? undefined : { top: 0 };
  },
});

router.beforeEach(async (to, from) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.refresh();
  if (!to.meta.public && !auth.user) return { name: 'login', query: { returnTo: to.fullPath } };
  if (to.name === 'login' && auth.user) return safeReturnPath(to.query.returnTo);
  if (auth.user && from.fullPath !== to.fullPath && hasUnsavedChanges()) {
    const leave = await useUiStore().confirm({
      title: '离开前保留当前编辑？',
      description: `${unsavedLabels()}有尚未保存的修改，离开后需要重新填写。`,
      confirmText: '放弃修改并离开',
    });
    if (!leave) return false;
    discardUnsavedChanges();
  }
});
router.afterEach((to, _from, failure) => {
  if (failure) return;
  document.title = `${String(to.meta.title ?? '工作台')} · Ozz`;
  const ui = useUiStore();
  ui.navigationOpen = false;
  ui.commandOpen = false;
  ui.settleConfirmation(false);
});
