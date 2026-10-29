import { monitorEventLoopDelay } from 'node:perf_hooks';
import { clearInterval, setInterval } from 'node:timers';

let measurement;
const send = (message) => {
  if (process.connected) process.send(message);
};

function sample() {
  if (!measurement) return;
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage(measurement.previousCpu);
  const elapsedMicros = Number(now - measurement.previousTime) / 1000;
  const memory = process.memoryUsage();
  measurement.peakRss = Math.max(measurement.peakRss, memory.rss);
  send({
    type: 'baseline.sample',
    elapsedSeconds: Number(now - measurement.startedAt) / 1e9,
    cpuUserPercent: (cpu.user / elapsedMicros) * 100,
    cpuSystemPercent: (cpu.system / elapsedMicros) * 100,
    cpuPercent: ((cpu.user + cpu.system) / elapsedMicros) * 100,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  });
  measurement.previousCpu = process.cpuUsage();
  measurement.previousTime = now;
}

process.on('message', (message) => {
  if (message?.type === 'baseline.start' && !measurement) {
    const startedAt = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    measurement = {
      startedAt,
      initialCpu: cpu,
      previousCpu: cpu,
      previousTime: startedAt,
      initialRss: memory.rss,
      peakRss: memory.rss,
      histogram,
    };
    measurement.timer = setInterval(sample, 1000);
    measurement.timer.unref();
    send({ type: 'baseline.started', pid: process.pid, nodeVersion: process.version });
  } else if (message?.type === 'baseline.stop' && measurement) {
    sample();
    clearInterval(measurement.timer);
    measurement.histogram.disable();
    const elapsedSeconds = Number(process.hrtime.bigint() - measurement.startedAt) / 1e9;
    const cpu = process.cpuUsage(measurement.initialCpu);
    send({
      type: 'baseline.summary',
      elapsedSeconds,
      cpuUserMicroseconds: cpu.user,
      cpuSystemMicroseconds: cpu.system,
      averageCpuPercent: ((cpu.user + cpu.system) / (elapsedSeconds * 1e6)) * 100,
      rssStartBytes: measurement.initialRss,
      rssEndBytes: process.memoryUsage().rss,
      rssPeakBytes: measurement.peakRss,
      eventLoopDelay: {
        resolutionMs: 20,
        p50Ms: measurement.histogram.percentile(50) / 1e6,
        p95Ms: measurement.histogram.percentile(95) / 1e6,
        maxMs: measurement.histogram.max / 1e6,
      },
    });
    measurement = undefined;
  }
});

process.on('disconnect', () => {
  if (measurement) {
    clearInterval(measurement.timer);
    measurement.histogram.disable();
  }
});
