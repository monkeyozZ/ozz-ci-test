<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue';
import { Info } from '@lucide/vue';
import CopyButton from '@/components/CopyButton.vue';
import { dateTime } from '@/lib/utils';
import NetworkObservationSection from './NetworkObservationSection.vue';
import {
  certificateAuthorityLabel,
  certificateEnvironmentLabel,
  certificateStatus,
  dnsStatus,
  routeStatus,
} from './presentation';
import type { Domain } from './types';

const props = defineProps<{ domain: Domain }>();
const now = ref(Date.now());
const timer = window.setInterval(() => (now.value = Date.now()), 30_000);
onScopeDispose(() => window.clearInterval(timer));
const certificate = computed(() => certificateStatus(props.domain.certificate, now.value));
</script>
<template>
  <div data-domain-observations>
    <NetworkObservationSection
      title="DNS"
      :status="dnsStatus(domain.dns)"
      :observed-at="domain.dns?.observedAt"
      :stale="domain.observationStale"
      :message="domain.dns?.message"
      data-network-state="dns"
    >
      <dl v-if="domain.dns" class="detail-list mt-3">
        <div>
          <dt>预期入口</dt>
          <dd class="mono">
            <p v-for="address in domain.dns.expectedAddresses" :key="address" class="dns-value">
              <span>{{ address }}</span
              ><CopyButton
                :text="address"
                :label="`复制预期 ${address.includes(':') ? 'AAAA' : 'A'} 记录值 ${address}`"
                compact
              />
            </p>
            <p v-if="domain.dns.expectedCname" class="dns-value">
              <span>CNAME {{ domain.dns.expectedCname }}</span
              ><CopyButton :text="domain.dns.expectedCname" label="复制预期 CNAME 目标" compact />
            </p>
            <span v-if="!domain.dns.expectedAddresses.length && !domain.dns.expectedCname"
              >尚未配置</span
            >
          </dd>
        </div>
        <div>
          <dt>解析地址</dt>
          <dd class="mono">
            <p v-for="address in domain.dns.addresses" :key="address" class="dns-value">
              <span>{{ address }}</span
              ><CopyButton
                :text="address"
                :label="`复制解析 ${address.includes(':') ? 'AAAA' : 'A'} 记录值 ${address}`"
                compact
              />
            </p>
            <span v-if="!domain.dns.addresses.length">本次没有地址结果</span>
          </dd>
        </div>
        <div v-if="domain.dns.cnameChain.length">
          <dt>CNAME 路径</dt>
          <dd class="mono">
            <p
              v-for="(hostname, index) in domain.dns.cnameChain"
              :key="`${index}:${hostname}`"
              class="dns-value"
            >
              <span>{{ index ? '→ ' : '' }}{{ hostname }}</span
              ><CopyButton :text="hostname" :label="`复制 CNAME 路径 ${hostname}`" compact />
            </p>
          </dd>
        </div>
      </dl>
      <p class="meta mt-3">这是本次解析结果，不能据此确认所有地区的 DNS 已更新。</p>
      <p v-if="domain.dns?.code" class="meta mono mt-3">{{ domain.dns.code }}</p>
    </NetworkObservationSection>
    <NetworkObservationSection
      title="路由与后端"
      :status="routeStatus(domain.route)"
      :observed-at="domain.route?.observedAt"
      :stale="domain.observationStale"
      :message="domain.route?.message"
      data-network-state="route"
    >
      <dl class="detail-list mt-3">
        <div>
          <dt>绑定端口</dt>
          <dd>
            <span class="mono"
              >{{ domain.servicePort.name }}:{{ domain.servicePort.servicePort }}</span
            >
            <span class="meta">
              · HTTP · 已发布 r{{ domain.servicePort.publishedConfigRevision }}</span
            >
          </dd>
        </div>
        <template v-if="domain.route">
          <div>
            <dt>后端服务</dt>
            <dd class="mono">{{ domain.route.backendServiceName }}</dd>
          </div>
          <div>
            <dt>就绪端点</dt>
            <dd>{{ domain.route.readyEndpoints ?? '未知' }}</dd>
          </div>
          <div>
            <dt>受管路由</dt>
            <dd class="mono">
              <p v-for="name in domain.route.ingressNames" :key="name">{{ name }}</p>
              <span v-if="!domain.route.ingressNames.length">尚未观察到</span>
            </dd>
          </div>
        </template>
      </dl>
      <p v-if="domain.route?.code" class="meta mono mt-3">{{ domain.route.code }}</p>
    </NetworkObservationSection>
    <NetworkObservationSection
      title="TLS 证书"
      :status="certificate"
      :observed-at="domain.certificate?.observedAt"
      :stale="domain.observationStale"
      :message="domain.certificate?.message"
      data-network-state="certificate"
    >
      <dl class="detail-list mt-3">
        <div>
          <dt>期望签发环境</dt>
          <dd>{{ certificateEnvironmentLabel(domain.certificateEnvironment) }}</dd>
        </div>
        <template v-if="domain.certificate">
          <div>
            <dt>签发来源</dt>
            <dd>{{ certificateAuthorityLabel(domain.certificate) }}</dd>
          </div>
          <div>
            <dt>本次证书环境</dt>
            <dd>{{ certificateEnvironmentLabel(domain.certificate.environment) }}</dd>
          </div>
          <div>
            <dt>生效时间</dt>
            <dd>{{ dateTime(domain.certificate.notBefore) }}</dd>
          </div>
          <div>
            <dt>到期时间</dt>
            <dd>{{ dateTime(domain.certificate.notAfter) }}</dd>
          </div>
          <div>
            <dt>计划续期</dt>
            <dd>{{ dateTime(domain.certificate.renewalTime) }}</dd>
          </div>
          <div>
            <dt>证书资源</dt>
            <dd class="mono">{{ domain.certificate.certificateName }}</dd>
          </div>
          <div>
            <dt>签发器</dt>
            <dd class="mono">{{ domain.certificate.issuerName }}</dd>
          </div>
        </template>
      </dl>
      <div v-if="domain.certificate?.authority === 'local_test'" class="notice notice-warning mt-4">
        <Info aria-hidden="true" />
        <p>
          本地测试证书由本地 CA 签发，浏览器默认不信任。此结果用于验证流程，不能确认公网 HTTPS
          可用。
        </p>
      </div>
      <div
        v-else-if="
          domain.certificateEnvironment === 'staging' ||
          domain.certificate?.environment === 'staging'
        "
        class="notice notice-warning mt-4"
      >
        <Info aria-hidden="true" />
        <p>staging 用于验证签发流程，测试证书不受浏览器信任。正式证书需要单独申请。</p>
      </div>
      <p v-if="domain.certificate?.code" class="meta mono mt-3">{{ domain.certificate.code }}</p>
    </NetworkObservationSection>
  </div>
</template>
<style scoped>
.dns-value {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 0.5rem;
}
.dns-value > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
