import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readlink, statfs, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { sha256File } from '../../infra/local-lab/download.mjs';

// Installs only the separately designated local Builder VM. Application nodes,
// the control-plane database and retained VM/container data are never changed.
const root = resolve(import.meta.dirname, '../..');
const local = resolve(root, '.local/local-lab/builder');
const bundleName = process.argv[2];
if (!/^s6-[a-z0-9-]+$/u.test(bundleName ?? '')) throw new Error('BUILDER_BUNDLE_REQUIRED');
const bundle = resolve(local, 'bundles', bundleName);
const id = `install-${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
const directory = resolve(local, 'installations', id);
const remote = `/home/ozz/ozz-builder-${id}`;
const application = `/opt/ozz-builder/releases/${bundleName}`;
const ssh = ['-F', resolve(local, 'credentials/ssh_config'), 'ozz-build'];
const report = {
  version: 1,
  id,
  status: 'running',
  startedAt: new Date().toISOString(),
  bundle: bundleName,
  transfers: [],
  steps: [],
};
process.umask(0o077);
await mkdir(directory, { recursive: true, mode: 0o700 });

function requireValue(value, code) {
  if (!value) throw new Error(code);
}

async function command(step, executable, args, options = {}) {
  const log = createWriteStream(resolve(directory, `${step}.log`), { flags: 'wx', mode: 0o600 });
  const startedAt = new Date().toISOString();
  const result = await new Promise((accept, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 60_000);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      log.end();
      accept({ code, signal });
    });
    if (options.inputFile) createReadStream(options.inputFile).pipe(child.stdin);
    else child.stdin.end(options.input);
  });
  report.steps.push({ step, startedAt, completedAt: new Date().toISOString(), ...result });
  await writeFile(resolve(directory, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  requireValue(result.code === 0, `BUILDER_${step.toUpperCase().replaceAll('-', '_')}_FAILED`);
  console.log(JSON.stringify({ step, status: 'passed' }));
}

try {
  const disk = await statfs(root);
  requireValue(disk.bavail * disk.bsize >= 8 * 1024 ** 3, 'BUILDER_HOST_DISK_RESERVE_LOW');
  const manifestFile = resolve(bundle, 'builder-bundle-manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  for (const entry of manifest.entries) {
    requireValue(
      /^(apps\/builder|packages\/infrastructure)\/[A-Za-z0-9_./@-]+$/u.test(entry.path) &&
        !entry.path.split('/').includes('..'),
      'BUILDER_BUNDLE_PATH_INVALID',
    );
    const file = resolve(bundle, entry.path);
    const info = await lstat(file);
    if (entry.symlink !== undefined || entry.target !== undefined) {
      requireValue(
        info.isSymbolicLink() && (await readlink(file)) === (entry.symlink ?? entry.target),
        'BUILDER_BUNDLE_SYMLINK_MISMATCH',
      );
    } else {
      requireValue(
        info.isFile() && info.size === entry.bytes && (await sha256File(file)) === entry.sha256,
        'BUILDER_BUNDLE_HASH_MISMATCH',
      );
    }
  }
  report.bundleManifestSha256 = await sha256File(manifestFile);
  const assetLock = JSON.parse(
    await readFile(resolve(root, 'infra/builder/assets.lock.json'), 'utf8'),
  );
  const transfers = [];
  for (const asset of assetLock.archives) {
    const file = resolve(local, 'assets', basename(new URL(asset.url).pathname));
    requireValue((await sha256File(file)) === asset.sha256, 'BUILDER_ASSET_HASH_MISMATCH');
    transfers.push({ file, path: `assets/${basename(file)}`, sha256: asset.sha256 });
  }
  for (const name of [
    'install.py',
    'launcher.py',
    'phase-helper.py',
    'phase-entry.py',
    'assets.lock.json',
  ]) {
    const file = resolve(root, 'infra/builder', name);
    transfers.push({ file, path: `installer/${name}`, sha256: await sha256File(file) });
  }
  for (const name of ['server.crt', 'server.key', 'ca.crt']) {
    const file = resolve(local, 'pki', name);
    transfers.push({ file, path: `pki/${name}`, sha256: await sha256File(file), private: true });
  }
  const config = resolve(local, 'operator-config.json');
  transfers.push({
    file: config,
    path: 'operator-config.json',
    sha256: await sha256File(config),
    private: true,
  });
  await command('fresh-host', 'ssh', [...ssh, 'sudo python3 -I -'], {
    input: `from pathlib import Path\nimport json,shutil\nassert Path('/etc/ozz-source-builder-instance').read_text().strip() == 'ozz-build'\nassert not Path('/etc/ozz-builder/installation-receipt.json').exists(), 'Existing installation requires separate reviewed repair'\nassert shutil.disk_usage('/var/lib').free >= 5 * 1024**3\nprint(json.dumps({'dedicatedHost':True,'freeBytes':shutil.disk_usage('/var/lib').free}))\n`,
  });
  await command('create-stage', 'ssh', [
    ...ssh,
    `umask 077 && mkdir -p ${remote}/assets ${remote}/installer ${remote}/pki ${remote}/application`,
  ]);
  for (let i = 0; i < transfers.length; i += 1) {
    const entry = transfers[i];
    await command(
      `transfer-${i + 1}`,
      'scp',
      [
        '-q',
        '-F',
        resolve(local, 'credentials/ssh_config'),
        entry.file,
        `ozz-build:${remote}/${entry.path}`,
      ],
      { timeout: 180_000 },
    );
    report.transfers.push({ path: entry.path, sha256: entry.sha256 });
  }
  const archive = resolve(directory, 'application.tar');
  await command('archive-bundle', '/usr/bin/tar', ['-cf', archive, '-C', bundle, '.']);
  await chmod(archive, 0o600);
  await command('transfer-bundle', 'ssh', [...ssh, `tar -xf - -C ${remote}/application`], {
    inputFile: archive,
  });
  const verification = `import hashlib,json,os,shutil\nfrom pathlib import Path\nbase=Path(${JSON.stringify(remote)})\nentries=${JSON.stringify(transfers.map(({ path, sha256 }) => ({ path, sha256 })))}\nfor entry in entries:\n p=base/entry['path']\n assert p.is_file() and not p.is_symlink()\n assert hashlib.file_digest(p.open('rb'),'sha256').hexdigest()==entry['sha256']\napp=base/'application'\nmanifest=json.loads((app/'builder-bundle-manifest.json').read_text())\nfor entry in manifest['entries']:\n p=app/entry['path']\n target=entry.get('symlink',entry.get('target'))\n if target is not None:\n  assert p.is_symlink() and os.readlink(p)==target\n else:\n  assert p.is_file() and not p.is_symlink() and p.stat().st_size==entry['bytes']\n  assert hashlib.file_digest(p.open('rb'),'sha256').hexdigest()==entry['sha256']\nfor p in app.rglob('*'):\n if p.is_symlink(): assert p.resolve().is_relative_to(app.resolve())\npki=Path('/var/lib/ozz-builder-bootstrap/pki')\npki.mkdir(parents=True,exist_ok=True,mode=0o700)\nos.chmod(pki.parent,0o700)\nos.chmod(pki,0o700)\nfor name in ('server.crt','server.key','ca.crt'):\n out=pki/name\n assert not out.exists()\n shutil.copyfile(base/'pki'/name,out)\n os.chmod(out,0o600)\ndestination=Path(${JSON.stringify(application)})\nassert not destination.exists()\ndestination.parent.mkdir(parents=True,exist_ok=True,mode=0o755)\nshutil.copytree(app,destination,symlinks=True)\nprint(json.dumps({'transferHashesVerified':len(entries),'bundleEntriesVerified':len(manifest['entries']),'caPrivateKeyTransferred':False,'clientPrivateKeyTransferred':False}))\n`;
  await command('verify-and-place', 'ssh', [...ssh, 'sudo python3 -I -'], { input: verification });
  await command(
    'install',
    'ssh',
    [
      ...ssh,
      `sudo python3 -I ${remote}/installer/install.py --config ${remote}/operator-config.json --assets ${remote}/assets --application-dir ${application} --designate-dedicated-host --start`,
    ],
    { timeout: 900_000 },
  );
  await command('installation-receipt', 'ssh', [
    ...ssh,
    'sudo cat /etc/ozz-builder/installation-receipt.json',
  ]);
  await command('native-load', 'ssh', [
    ...ssh,
    `/opt/ozz-builder/bin/node --version && /opt/ozz-builder/bin/node -e 'require("${application}/apps/builder/dist/main.js")' && sudo systemctl is-active ozz-builder.service ozz-builder-watchdog.timer`,
  ]);
  await command('preflight', 'ssh', [
    ...ssh,
    'sudo -u ozz-builder sudo -n /usr/local/libexec/ozz-builder-launch preflight',
  ]);
  report.status = 'passed';
  report.realBuildVerified = false;
} catch (error) {
  report.status = 'failed';
  report.errorCode = /^BUILDER_[A-Z0-9_]+$/u.test(error.message ?? '')
    ? error.message
    : 'BUILDER_INSTALL_PROBE_FAILED';
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(resolve(directory, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      errorCode: report.errorCode,
      report: resolve(directory, 'results.json'),
    }),
  );
}
