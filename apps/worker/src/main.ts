import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import {
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createLogger, loadConfig } from '@ozz/config';
import { DatabaseModule, PrismaService } from '@ozz/database';
import type { BuildReconciler } from '@ozz/control-plane/builds';
import { GitWebhookDispatcher } from '@ozz/control-plane/git';
import { TaskRepository, TaskRuntime, integrationOperationKinds } from '@ozz/control-plane/tasks';
import { SecretCipher, readMasterKeys } from '@ozz/control-plane/secrets';
import { ClusterObserver, InfrastructureExecutor } from '@ozz/control-plane/infrastructure';
import { ServiceExecutor, ServiceObserver } from '@ozz/control-plane/services';
import { StorageExecutor, StorageObserver, isStorageOperation } from '@ozz/control-plane/storage';
import { establishDatabaseFence } from '@ozz/control-plane/databases';
import { RegistryAdapter, RegistryProbe } from '@ozz/infrastructure/registry';
import {
  DomainObserver,
  isNetworkingOperation,
  NetworkingExecutor,
} from '@ozz/control-plane/networking';
import {
  KubernetesNetworkingAdapter,
  NodeDomainDnsInspector,
} from '@ozz/infrastructure/networking';
import { readLocalAcmeConfiguration } from './networking-config.js';
import { createWorkerGitExecution, type WorkerGitExecutionOptions } from './git-build.js';

const logger = createLogger('worker');

@Injectable()
class WorkerLifecycle implements OnModuleInit, OnModuleDestroy {
  private runtime: TaskRuntime | undefined;
  private server: Server | undefined;
  private observer: ClusterObserver | undefined;
  private serviceObserver: ServiceObserver | undefined;
  private domainObserver: DomainObserver | undefined;
  private storageObserver: StorageObserver | undefined;
  private buildReconciler: BuildReconciler | undefined;
  private gitDispatcher: GitWebhookDispatcher | undefined;

  constructor(
    private readonly database: PrismaService,
    private readonly gitOptions: WorkerGitExecutionOptions = {},
  ) {}

  async onModuleInit(): Promise<void> {
    const config = loadConfig();
    const cipher = new SecretCipher(readMasterKeys(config.masterKeyFile));
    for (const check of await this.database.keyVerification.findMany()) {
      const value = cipher.decrypt({ ...check, kind: 'key-verification' });
      if (value.purpose !== 'ozz-key-verification-v1')
        throw new Error('Master key verification failed');
    }
    // Restored data may predate verification records; retained key versions must
    // still authenticate before this process is allowed to publish any task.
    for (const secret of await this.database.secretReference.findMany({
      distinct: ['keyVersion'],
    })) {
      cipher.decrypt(secret);
    }
    const repository = new TaskRepository(this.database, {
      logRetentionMs: config.taskLogRetentionDays * 86_400_000,
      logMaxBytes: config.taskLogMaxBytes,
    });
    const networkManager = new KubernetesNetworkingAdapter({
      localAcme: await readLocalAcmeConfiguration(config),
    });
    const dns = new NodeDomainDnsInspector({ servers: config.networkDnsServers });
    const networking = new NetworkingExecutor(repository, cipher, networkManager, dns);
    const infrastructure = new InfrastructureExecutor(repository, cipher);
    const storage = new StorageExecutor(repository, cipher, undefined, {
      beforeDataWrite: establishDatabaseFence,
    });
    const registry = new RegistryAdapter({
      httpProxy: config.registryHttpProxy,
      proxyBlobOrigins: config.registryProxyBlobOrigins,
    });
    const { builds, integrations, buildReconciler, gitDispatcher } = createWorkerGitExecution(
      repository,
      cipher,
      registry,
      {
        ...this.gitOptions,
        registryProbe:
          this.gitOptions.registryProbe ??
          new RegistryProbe({
            httpProxy: config.registryHttpProxy,
            proxyBlobOrigins: config.registryProxyBlobOrigins,
          }),
      },
    );
    this.buildReconciler = buildReconciler;
    this.gitDispatcher = gitDispatcher;
    const services = new ServiceExecutor(
      repository,
      cipher,
      registry,
      undefined,
      undefined,
      networking,
      storage,
      builds,
    );
    this.runtime = new TaskRuntime(repository, {
      redisUrl: config.redisUrl,
      logger,
      executor: {
        execute: (lease, signal) =>
          (integrationOperationKinds as readonly string[]).includes(lease.kind)
            ? integrations.execute(lease, signal)
            : isStorageOperation(lease.kind)
              ? storage.execute(lease, signal)
              : isNetworkingOperation(lease.kind)
                ? networking.execute(lease, signal)
                : lease.kind.startsWith('service_')
                  ? services.execute(lease, signal)
                  : infrastructure.execute(lease, signal),
        failed: (lease, tx, code, message) =>
          (integrationOperationKinds as readonly string[]).includes(lease.kind)
            ? integrations.failed(lease, tx, code)
            : isStorageOperation(lease.kind)
              ? storage.failed(lease, tx, code, message)
              : isNetworkingOperation(lease.kind)
                ? networking.failed(lease, tx, code, message)
                : lease.kind.startsWith('service_')
                  ? services.failed(lease, tx, code, message)
                  : infrastructure.failed(lease, tx, code, message),
      },
      deploymentExecutor: services,
    });
    this.observer = new ClusterObserver(repository, cipher);
    this.serviceObserver = new ServiceObserver(repository, cipher);
    this.domainObserver = new DomainObserver(repository, cipher, networkManager, dns);
    this.storageObserver = new StorageObserver(repository, cipher);
    this.runtime.start();
    this.observer.start();
    this.serviceObserver.start();
    this.domainObserver.start();
    this.storageObserver.start();
    this.buildReconciler.start();
    this.gitDispatcher.start();
    this.server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      if (
        request.method !== 'GET' ||
        !['/health/live', '/health/ready'].includes(request.url ?? '')
      ) {
        response.writeHead(404).end(JSON.stringify({ status: 'not_found' }));
        return;
      }
      const health = this.runtime!.health();
      response.statusCode = request.url === '/health/live' || health.status === 'ready' ? 200 : 503;
      response.end(JSON.stringify(health));
    });
    this.server.requestTimeout = 5_000;
    this.server.headersTimeout = 5_000;
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(config.workerHealthPort, config.host, () => {
          this.server!.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      await this.observer.stop();
      await this.serviceObserver.stop();
      await this.domainObserver.stop();
      await this.storageObserver.stop();
      await this.buildReconciler.stop();
      await this.gitDispatcher.stop();
      await this.runtime.stop();
      await this.database.$disconnect();
      throw error;
    }
    logger.info({ port: config.workerHealthPort }, 'Worker internal health endpoint is listening');
  }

  async onModuleDestroy(): Promise<void> {
    await this.observer?.stop();
    await this.serviceObserver?.stop();
    await this.domainObserver?.stop();
    await this.storageObserver?.stop();
    await this.buildReconciler?.stop();
    await this.gitDispatcher?.stop();
    await this.runtime?.stop();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    // The runtime may write a final heartbeat after the global database module's
    // destroy hook. Ensure that no connection opened for that write remains live.
    await this.database.$disconnect();
  }
}

@Module({})
class WorkerModule {
  static withGitExecution(options: WorkerGitExecutionOptions): DynamicModule {
    return {
      module: WorkerModule,
      imports: [DatabaseModule],
      providers: [
        {
          provide: WorkerLifecycle,
          inject: [PrismaService],
          useFactory: (database: PrismaService) => new WorkerLifecycle(database, options),
        },
      ],
    };
  }
}

/** Full production lifecycle with a typed Git fixture seam; importing this file never starts a Worker. */
export async function startWorker(options: WorkerGitExecutionOptions = {}) {
  loadConfig();
  const app = await NestFactory.createApplicationContext(WorkerModule.withGitExecution(options), {
    logger: false,
    abortOnError: false,
  });
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  return app;
}

// The container environment launcher imports the entrypoint after setting argv[1].
if (require.main === module || process.argv[1] === __filename)
  void startWorker().catch(() => {
    logger.fatal(
      { code: 'WORKER_STARTUP_FAILED' },
      'Worker could not start; check configuration and dependency availability',
    );
    // Application-context creation can fail before Nest returns a handle to close
    // already initialized providers. Exit after the safe error is flushed.
    logger.flush();
    process.exit(1);
  });
