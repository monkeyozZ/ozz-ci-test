import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { preflightScript } from '../../packages/infrastructure/dist/ssh/preflight-script.js';
import { initializeScript } from '../../packages/infrastructure/dist/ssh/install-script.js';

function python(program: string, source: string): unknown {
  // Exercise the actual reviewed Python functions in an isolated process. Only
  // selected definitions are compiled; no host inspection or installation runs.
  const result = spawnSync('python3', ['-c', program], {
    input: source,
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 64 * 1024,
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  return JSON.parse(result.stdout);
}

describe('reviewed SSH installation programs', () => {
  it('reads only the structured K3s enable boolean and treats errors or malformed output as unknown', () => {
    const observed = python(
      String.raw`
import ast,json,sys,types
tree=ast.parse(sys.stdin.read())
definition=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='encryption_observation')
results=[]
commands=[]
for code,output in [(0,'{"enable":true,"stage":"start"}'),(0,'{"enable":false}'),(0,'{"enable":"true"}'),(0,'{"enabled":true}'),(0,'[]'),(0,'not-json'),(1,'{"enable":true}')]:
    def run_checked(args):
        commands.append(args)
        return code,output
    namespace={'json':json,'os':types.SimpleNamespace(geteuid=lambda:0,path=types.SimpleNamespace(isfile=lambda path:True)),'run_checked':run_checked}
    exec(compile(ast.Module(body=[definition],type_ignores=[]),'<status-parser>','exec'),namespace)
    results.append(namespace['encryption_observation']())
print(json.dumps({'results':results,'structuredStatusRequests':all(command[-2:]==['--output','json'] for command in commands)}))
`,
      preflightScript,
    );
    expect(observed).toEqual({
      results: ['enabled', 'disabled', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'],
      structuredStatusRequests: true,
    });
  });

  it('waits through initial supervisor readiness and fails within the bound if encryption stays disabled', () => {
    const script = initializeScript({
      installationId: '20eaf948-31e7-4c97-9dfe-57e6443562e4',
      machineId: '0'.repeat(32),
      nodeName: 'ozz-test-node',
      apiEndpoint: 'https://127.0.0.1:36443',
      apiHostname: '127.0.0.1',
      timeoutSeconds: 600,
    });
    const observed = python(
      String.raw`
import ast,json,sys
tree=ast.parse(sys.stdin.read())
definitions=[node for node in tree.body if isinstance(node,(ast.ClassDef,ast.FunctionDef)) and node.name in ('SafeFailure','wait_encryption')]
results=[]
for values in (['unknown','disabled','enabled'],['disabled']):
    class Clock:
        now=0
        def monotonic(self): return self.now
        def sleep(self,seconds): self.now+=seconds
    clock=Clock()
    calls=[0]
    def observation():
        index=min(calls[0],len(values)-1)
        calls[0]+=1
        return values[index]
    namespace={'time':clock,'DEADLINE':600,'check_deadline':lambda:None,'encryption_observation':observation}
    exec(compile(ast.Module(body=definitions,type_ignores=[]),'<encryption-wait>','exec'),namespace)
    try:
        namespace['wait_encryption']()
        results.append({'status':'enabled','elapsed':clock.now,'calls':calls[0]})
    except namespace['SafeFailure'] as error:
        results.append({'status':error.code,'elapsed':clock.now,'calls':calls[0]})
print(json.dumps(results))
`,
      script,
    );
    expect(observed).toEqual([
      { status: 'enabled', elapsed: 2, calls: 3 },
      { status: 'SSH_ENCRYPTION_NOT_ENABLED', elapsed: 30, calls: 30 },
    ]);
  });
});
