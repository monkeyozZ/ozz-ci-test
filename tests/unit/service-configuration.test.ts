import { describe, expect, it } from 'vitest';
import { SERVICE_CONFIG_MAX_BYTES } from '../../packages/control-plane/src/services/contracts.js';
import {
  parseEnvironmentFile,
  validateServiceConfiguration,
} from '../../packages/control-plane/src/services/validation.js';
import { OperationRequestError } from '../../packages/control-plane/src/tasks/contracts.js';

const image = 'nginx:alpine';
const secretId = '00000000-0000-4000-8000-000000000001';
const httpPort = { name: 'http', protocol: 'http', containerPort: 8080 };
const marker = 'synthetic-secret-not-for-diagnostics';

function requestError(action: () => unknown, code?: string): OperationRequestError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OperationRequestError);
  if (!(caught instanceof OperationRequestError)) throw new Error('Expected a typed request error');
  expect(caught.status).toBe(422);
  if (code) expect(caught.code).toBe(code);
  expect(String(caught)).not.toContain(marker);
  expect(JSON.stringify(caught)).not.toContain(marker);
  return caught;
}

describe('service configuration admission', () => {
  it('fills complete defaults without modifying the input and accepts its own normalized output', () => {
    const input = { image };
    const result = validateServiceConfiguration(input);
    expect(result).toEqual({
      image,
      replicas: 1,
      command: [],
      args: [],
      ports: [],
      resources: {
        requests: { cpuMillis: 100, memoryMiB: 128 },
        limits: { cpuMillis: 500, memoryMiB: 512 },
      },
      environment: [],
      readiness: null,
      startup: null,
      healthTimeoutSeconds: 300,
    });
    expect(input).toEqual({ image });
    expect(validateServiceConfiguration(result)).toEqual(result);
  });

  it('preserves argument boundaries and runtime values without expanding shell or variable syntax', () => {
    const value = 'x=y#z\n${HOME} $(printf nope) `date` \\n';
    const result = validateServiceConfiguration({
      image,
      command: ['node'],
      args: ['', '--message=hello world', '${HOME}', '$(date)', ' leading and trailing '],
      environment: [
        { name: 'LITERAL', value },
        { name: '_EMPTY', value: '' },
      ],
    });
    expect(result.args).toEqual([
      '',
      '--message=hello world',
      '${HOME}',
      '$(date)',
      ' leading and trailing ',
    ]);
    expect(result.environment).toEqual([
      { name: 'LITERAL', value, secret: false },
      { name: '_EMPTY', value: '', secret: false },
    ]);
  });

  it('supports legal IANA port names and multiple service ports targeting one container port', () => {
    const result = validateServiceConfiguration({
      image,
      ports: [
        { name: '9-http', protocol: 'http', containerPort: 8080 },
        { name: 'tcp', protocol: 'tcp', containerPort: 8080, servicePort: 80 },
        { name: 'a'.repeat(15), protocol: 'tcp', containerPort: 65535, servicePort: 1 },
      ],
    });
    expect(result.ports.map((port) => port.servicePort)).toEqual([8080, 80, 1]);
    expect(result.ports.map((port) => port.containerPort)).toEqual([8080, 8080, 65535]);
  });

  it.each(['123', '-http', 'http-', 'http--api', 'Http', 'http_api', 'a'.repeat(16), '端口'])(
    'rejects an invalid named port: %s',
    (name) =>
      requestError(() => validateServiceConfiguration({ image, ports: [{ ...httpPort, name }] })),
  );

  it('rejects duplicate names and internal service ports independently', () => {
    for (const ports of [
      [httpPort, { ...httpPort, containerPort: 8081 }],
      [httpPort, { ...httpPort, name: 'other' }],
      [httpPort, { ...httpPort, name: 'other', containerPort: 8081, servicePort: 8080 }],
    ])
      requestError(() => validateServiceConfiguration({ image, ports }), 'SERVICE_PORT_INVALID');
  });

  it.each([['http'], { type: 'http' }, 'HTTP', 'udp', null, 1])(
    'does not coerce a port protocol: %j',
    (protocol) =>
      requestError(
        () => validateServiceConfiguration({ image, ports: [{ ...httpPort, protocol }] }),
        'SERVICE_PORT_INVALID',
      ),
  );

  it('checks port number ranges and types before applying defaults', () => {
    for (const field of ['containerPort', 'servicePort']) {
      for (const value of [0, 65536, 1.5, '80', null, Number.NaN]) {
        requestError(() =>
          validateServiceConfiguration({ image, ports: [{ ...httpPort, [field]: value }] }),
        );
      }
    }
  });

  it('accepts declared counts at their limits and rejects an extra entry', () => {
    const ports = Array.from({ length: 16 }, (_, index) => ({
      ...httpPort,
      name: `p${index}`,
      servicePort: index + 1,
    }));
    const environment = Array.from({ length: 128 }, (_, index) => ({
      name: `V_${index}`,
      value: '',
    }));
    const args = Array.from({ length: 64 }, () => 'a');
    expect(
      validateServiceConfiguration({ image, ports, environment, command: args, args }).environment,
    ).toHaveLength(128);
    for (const extra of [
      { ports: [...ports, { ...httpPort, name: 'extra' }] },
      { environment: [...environment, { name: 'EXTRA', value: '' }] },
      { args: [...args, 'extra'] },
      { command: [...args, 'extra'] },
    ])
      requestError(() => validateServiceConfiguration({ image, ...extra }));
  });

  it('enforces resource bounds, explicit quantities and request/limit ordering', () => {
    const requests = { cpuMillis: 1, memoryMiB: 16 };
    const limits = { cpuMillis: 64000, memoryMiB: 262144 };
    expect(
      validateServiceConfiguration({ image, resources: { requests, limits } }).resources,
    ).toEqual({ requests, limits });
    for (const resources of [
      { requests: { ...requests, cpuMillis: 0 }, limits },
      { requests, limits: { ...limits, cpuMillis: 64001 } },
      { requests: { ...requests, memoryMiB: 15 }, limits },
      { requests, limits: { ...limits, memoryMiB: 262145 } },
      { requests: { ...requests, cpuMillis: '100' }, limits },
      { requests: { ...requests, cpuMillis: 1.5 }, limits },
      { requests: { memoryMiB: 128 }, limits },
      { requests },
      { requests: limits, limits: requests },
      { requests: { cpuMillis: 1, memoryMiB: 256 }, limits: { cpuMillis: 2, memoryMiB: 128 } },
    ])
      requestError(() => validateServiceConfiguration({ image, resources }));
  });

  it('normalizes only supported HTTP and TCP probes and preserves a 2048-character path', () => {
    const longPath = '/' + 'p'.repeat(2047);
    const result = validateServiceConfiguration({
      image,
      ports: [httpPort],
      readiness: { type: 'http', port: 'http' },
      startup: {
        type: 'tcp',
        port: 'http',
        initialDelaySeconds: 600,
        periodSeconds: 60,
        timeoutSeconds: 30,
        failureThreshold: 120,
      },
    });
    expect(result.readiness).toEqual({
      type: 'http',
      port: 'http',
      path: '/',
      initialDelaySeconds: 0,
      periodSeconds: 5,
      timeoutSeconds: 2,
      failureThreshold: 3,
    });
    expect(result.startup).not.toHaveProperty('path');
    expect(
      validateServiceConfiguration({
        image,
        ports: [httpPort],
        readiness: { type: 'http', port: 'http', path: longPath },
      }).readiness?.path,
    ).toBe(longPath);
    expect(
      validateServiceConfiguration({ image, readiness: null, startup: null }).readiness,
    ).toBeNull();
  });

  it('rejects undeclared probe ports, type coercion and invalid paths without repeating input', () => {
    for (const probe of [
      { type: 'http', port: 'missing' },
      { type: 'http', port: 8080 },
      { type: ['http'], port: 'http' },
      { type: 'exec', port: 'http' },
      { type: 'tcp', port: 'http', path: '/' },
      { type: 'tcp', port: 'http', path: null },
      { type: 'http', port: 'http', path: 'https://example.test/' + marker },
      { type: 'http', port: 'http', path: null },
      { type: 'http', port: 'http', path: '/' + 'x'.repeat(2048) },
      ...[0, 9, 10, 13, 27, 31, 127, 128, 159].map((code) => ({
        type: 'http',
        port: 'http',
        path: '/' + marker + String.fromCharCode(code),
      })),
    ])
      requestError(() =>
        validateServiceConfiguration({ image, ports: [httpPort], readiness: probe }),
      );
  });

  it('validates each probe timing rather than coercing or defaulting invalid values', () => {
    const ranges: [string, number, number][] = [
      ['initialDelaySeconds', 0, 600],
      ['periodSeconds', 1, 60],
      ['timeoutSeconds', 1, 30],
      ['failureThreshold', 1, 120],
    ];
    for (const [field, min, max] of ranges) {
      for (const value of [min - 1, max + 1, 1.5, '5', null]) {
        requestError(() =>
          validateServiceConfiguration({
            image,
            ports: [httpPort],
            startup: { type: 'tcp', port: 'http', [field]: value },
          }),
        );
      }
    }
  });

  it('does not default explicit nulls and rejects unknown fields at every structured boundary', () => {
    for (const field of [
      'replicas',
      'command',
      'args',
      'ports',
      'resources',
      'environment',
      'healthTimeoutSeconds',
    ]) {
      requestError(() => validateServiceConfiguration({ image, [field]: null }));
    }
    for (const input of [
      { clusterId: marker },
      { ports: [{ ...httpPort, hostPort: marker }] },
      { environment: [{ name: 'A', value: marker, expand: true }] },
      {
        resources: {
          requests: { cpuMillis: 100, memoryMiB: 128, gpu: marker },
          limits: { cpuMillis: 500, memoryMiB: 512 },
        },
      },
      {
        resources: {
          requests: { cpuMillis: 100, memoryMiB: 128 },
          limits: { cpuMillis: 500, memoryMiB: 512 },
          [marker]: true,
        },
      },
      { ports: [httpPort], readiness: { type: 'http', port: 'http', headers: marker } },
    ])
      requestError(
        () => validateServiceConfiguration({ image, ...input }),
        'SERVICE_CONFIGURATION_INVALID',
      );
  });

  it('rejects invalid replica and health deadline values', () => {
    expect(
      validateServiceConfiguration({ image, replicas: 20, healthTimeoutSeconds: 900 }).replicas,
    ).toBe(20);
    expect(
      validateServiceConfiguration({ image, healthTimeoutSeconds: 10 }).healthTimeoutSeconds,
    ).toBe(10);
    for (const [field, values] of [
      ['replicas', [0, 21, 1.2, '1']],
      ['healthTimeoutSeconds', [9, 901, 1.2, '300']],
    ] as const) {
      for (const value of values)
        requestError(() => validateServiceConfiguration({ image, [field]: value }));
    }
  });

  it('keeps plaintext and secret references exclusive and makes duplicate variables locatable', () => {
    expect(
      validateServiceConfiguration({
        image,
        environment: [
          { name: 'RAW', value: marker, secret: true },
          { name: 'REF', secretRefId: secretId },
          { name: 'KEY', secretRefId: secretId, secretKey: 'password', secret: true },
        ],
      }).environment,
    ).toEqual([
      { name: 'RAW', value: marker, secret: true },
      { name: 'REF', secretRefId: secretId, secretKey: 'value' },
      { name: 'KEY', secretRefId: secretId, secretKey: 'password' },
    ]);
    for (const variable of [
      { name: 'A', value: marker, secretRefId: secretId },
      { name: 'A', secretRefId: secretId, secret: false },
      { name: 'A', value: marker, secretKey: 'password' },
      { name: 'A', secretRefId: secretId, secretKey: null },
      { name: 'A', secretRefId: marker },
      { name: 'A', value: marker, secret: 'true' },
      { name: 'A', value: marker, secret: null },
      { name: 'A', value: marker + '\0' },
      { name: '1A', value: marker },
      { name: 'A-B', value: marker },
      { name: 'A'.repeat(129), value: marker },
      { name: 'A' },
    ])
      requestError(() => validateServiceConfiguration({ image, environment: [variable] }));
    const duplicate = requestError(
      () =>
        validateServiceConfiguration({
          image,
          environment: [
            { name: 'TOKEN', value: marker },
            { name: 'OTHER', value: '' },
            { name: 'TOKEN', value: marker + '-duplicate' },
          ],
        }),
      'SERVICE_VARIABLES_INVALID',
    );
    expect(duplicate.message).toContain('第 3 项');
    expect(duplicate.message).toContain('第 1 项');
  });

  it('measures argument and variable limits in UTF-8 bytes', () => {
    const argument = '界'.repeat(1365) + 'a';
    const value = '界'.repeat(5461) + 'a';
    expect(Buffer.byteLength(argument)).toBe(4096);
    expect(Buffer.byteLength(value)).toBe(16 * 1024);
    expect(
      validateServiceConfiguration({ image, args: [argument], environment: [{ name: 'A', value }] })
        .environment[0]?.value,
    ).toBe(value);
    requestError(() => validateServiceConfiguration({ image, args: [argument + 'a'] }));
    requestError(() =>
      validateServiceConfiguration({ image, environment: [{ name: 'A', value: value + 'a' }] }),
    );
  });

  it('bounds both submitted and complete normalized configuration bytes', () => {
    const base = validateServiceConfiguration({
      image,
      environment: [
        { name: 'A', value: '' },
        { name: 'B', value: '' },
      ],
    });
    const remaining = SERVICE_CONFIG_MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
    base.environment[0]!.value = 'x'.repeat(12 * 1024);
    base.environment[1]!.value = 'x'.repeat(remaining - 12 * 1024);
    expect(Buffer.byteLength(JSON.stringify(base))).toBe(SERVICE_CONFIG_MAX_BYTES);
    expect(validateServiceConfiguration(base)).toEqual(base);
    base.environment[1]!.value += 'a';
    requestError(() => validateServiceConfiguration(base), 'SERVICE_CONFIGURATION_TOO_LARGE');
    const minimal = { image, environment: base.environment };
    expect(Buffer.byteLength(JSON.stringify(minimal))).toBeLessThan(SERVICE_CONFIG_MAX_BYTES);
    requestError(() => validateServiceConfiguration(minimal), 'SERVICE_CONFIGURATION_TOO_LARGE');
  });

  it('returns safe typed errors for malformed JSON-shaped inputs instead of serialization exceptions', () => {
    const cyclic: Record<string, unknown> = { image };
    cyclic.environment = [cyclic];
    for (const value of [
      null,
      [],
      'value',
      { image, replicas: BigInt(1) },
      cyclic,
      { image, args: Array(1) },
    ]) {
      requestError(() => validateServiceConfiguration(value));
    }
    expect(() =>
      validateServiceConfiguration({ image: 'https://user:' + marker + '@example.test/image' }),
    ).toThrow(/镜像引用无效/);
  });
});

describe('literal dotenv import', () => {
  it('accepts BOM, CRLF, export, whitespace, empty values and equals/hash characters', () => {
    const source =
      '\uFEFF# comment\r\n export APP = a=b=c # comment\rEMPTY=\r\nQUOTED="  a=b # c  "\r\nSINGLE=\'a=b#c\'\r\nSPACE=   trim me   ';
    const result = parseEnvironmentFile(source);
    expect(result.issues).toEqual([]);
    expect(result.variables.map(({ name, value, line }) => ({ name, value, line }))).toEqual([
      { name: 'APP', value: 'a=b=c', line: 2 },
      { name: 'EMPTY', value: '', line: 3 },
      { name: 'QUOTED', value: '  a=b # c  ', line: 4 },
      { name: 'SINGLE', value: 'a=b#c', line: 5 },
      { name: 'SPACE', value: 'trim me', line: 6 },
    ]);
  });

  it.each([0, 1, 2, 3, 4, 5, 6])(
    'handles %i backslashes immediately before a closing double quote',
    (count) => {
      const result = parseEnvironmentFile('VALUE="prefix' + '\\'.repeat(count) + '"');
      if (count % 2 === 0) {
        expect(result.issues).toEqual([]);
        expect(result.variables[0]?.value).toBe('prefix' + '\\'.repeat(count / 2));
      } else {
        expect(result.variables).toEqual([]);
        expect(result.issues).toEqual([
          { line: 1, code: 'INVALID_QUOTE', message: expect.any(String) },
        ]);
      }
    },
  );

  it('decodes supported double-quoted escapes once and preserves literal single/unquoted backslashes', () => {
    const source = [
      String.raw`DOUBLE="one\ntwo\rthree\t\"four\"\\end\q"`,
      String.raw`ESCAPED="literal\\n"`,
      String.raw`SINGLE='one\ntwo\t\\end'`,
      String.raw`TRAILING='last\'`,
      String.raw`UNQUOTED=c:\new\test`,
      'THREE="prefix' + '\\'.repeat(3) + '"tail"',
    ].join('\n');
    const result = parseEnvironmentFile(source);
    expect(result.issues).toEqual([]);
    expect(result.variables.map((variable) => variable.value)).toEqual([
      'one\ntwo\rthree\t"four"\\end\\q',
      String.raw`literal\n`,
      String.raw`one\ntwo\t\\end`,
      'last\\',
      String.raw`c:\new\test`,
      'prefix\\"tail',
    ]);
  });

  it('keeps physical multiline content and line numbers, including comments inside quotes', () => {
    const source = [
      'PRIVATE_KEY="first',
      '# inside value',
      '',
      'NAME=still value" # after quote',
      "SINGLE='line 1",
      "line 2'",
      'NEXT=last',
      'UNICODE="a\u2028b\u2029c" # comment\u2028tail',
      'CONTINUED="end\\',
      '"',
    ].join('\r\n');
    const result = parseEnvironmentFile(source);
    expect(result.issues).toEqual([]);
    expect(result.variables).toEqual([
      {
        name: 'PRIVATE_KEY',
        value: 'first\n# inside value\n\nNAME=still value',
        secret: true,
        line: 1,
      },
      { name: 'SINGLE', value: 'line 1\nline 2', secret: false, line: 5 },
      { name: 'NEXT', value: 'last', secret: false, line: 7 },
      { name: 'UNICODE', value: 'a\u2028b\u2029c', secret: false, line: 8 },
      { name: 'CONTINUED', value: 'end\\\n', secret: false, line: 9 },
    ]);
  });

  it('never expands variables or commands and never mutates the control-plane environment', () => {
    const previous = process.env.OZZ_ENV_IMPORT_TEST;
    const source = [
      'OZZ_ENV_IMPORT_TEST=${HOME}',
      'API_KEY="${TOKEN:-fallback}"',
      'COMMAND=$(printf nope)',
      "QUOTED='${NAME} $(date) `date`'",
    ].join('\n');
    const result = parseEnvironmentFile(source);
    expect(result.issues).toEqual([]);
    expect(result.variables.map((variable) => variable.value)).toEqual([
      '${HOME}',
      '${TOKEN:-fallback}',
      '$(printf nope)',
      '${NAME} $(date) `date`',
    ]);
    expect(result.variables[1]?.secret).toBe(true);
    expect(process.env.OZZ_ENV_IMPORT_TEST).toBe(previous);
  });

  it('locates duplicates and malformed assignments without including values in diagnostics', () => {
    const result = parseEnvironmentFile(
      [
        'TOKEN=' + marker,
        '# spacer',
        'TOKEN=' + marker + '-duplicate',
        '=' + marker,
        'BAD-NAME=' + marker,
        'GOOD=okay',
        'BROKEN="' + marker + '" extra',
      ].join('\n'),
    );
    expect(result.variables.map((variable) => variable.name)).toEqual(['TOKEN', 'GOOD']);
    expect(result.issues.map(({ line, code }) => ({ line, code }))).toEqual([
      { line: 3, code: 'DUPLICATE_NAME' },
      { line: 4, code: 'INVALID_ASSIGNMENT' },
      { line: 5, code: 'INVALID_ASSIGNMENT' },
      { line: 7, code: 'INVALID_QUOTE' },
    ]);
    expect(result.issues[0]?.message).toContain('第 1 行');
    expect(JSON.stringify(result.issues)).not.toContain(marker);
  });

  it('reports an unterminated multiline quote at its opening line without returning the invalid value', () => {
    const result = parseEnvironmentFile('GOOD=1\nBROKEN="' + marker + '\nstill open');
    expect(result.variables.map((variable) => variable.name)).toEqual(['GOOD']);
    expect(result.issues).toEqual([
      { line: 2, code: 'INVALID_QUOTE', message: expect.any(String) },
    ]);
    expect(JSON.stringify(result.issues)).not.toContain(marker);
  });

  it('enforces variable name and UTF-8 value limits with safe per-line issues', () => {
    const maxName = 'A'.repeat(128);
    const maxValue = '界'.repeat(5461) + 'a';
    const valid = parseEnvironmentFile(maxName + '=' + maxValue);
    expect(valid.issues).toEqual([]);
    expect(valid.variables[0]?.value).toBe(maxValue);
    const invalid = parseEnvironmentFile('A'.repeat(129) + '=short\nBIG=' + maxValue + 'a');
    expect(invalid.variables).toEqual([]);
    expect(invalid.issues.map(({ line, code }) => ({ line, code }))).toEqual([
      { line: 1, code: 'NAME_TOO_LONG' },
      { line: 2, code: 'VALUE_TOO_LARGE' },
    ]);
    expect(JSON.stringify(invalid.issues)).not.toContain('界');
  });

  it('bounds the returned variable count and locates the first overflow instead of silently truncating', () => {
    const lines = Array.from({ length: 130 }, (_, index) => `V_${index}=${index}`);
    lines.push('V_129=' + marker);
    const result = parseEnvironmentFile(lines.join('\n'));
    expect(result.variables).toHaveLength(128);
    expect(result.issues.map(({ line, code }) => ({ line, code }))).toEqual([
      { line: 129, code: 'TOO_MANY_VARIABLES' },
      { line: 131, code: 'DUPLICATE_NAME' },
    ]);
    expect(JSON.stringify(result.issues)).not.toContain(marker);
    expect(parseEnvironmentFile(lines.slice(0, 128).join('\n')).issues).toEqual([]);
  });

  it('bounds input UTF-8 bytes and rejects NUL and non-text sources with typed errors', () => {
    const source = '#' + '界'.repeat((SERVICE_CONFIG_MAX_BYTES - 3) / 3) + 'aa';
    expect(Buffer.byteLength(source)).toBe(SERVICE_CONFIG_MAX_BYTES);
    expect(parseEnvironmentFile(source)).toEqual({ variables: [], issues: [] });
    for (const value of [source + 'a', null, {}, ['A=1'], 'A=' + marker + '\0']) {
      requestError(() => parseEnvironmentFile(value), 'SERVICE_ENV_IMPORT_INVALID');
    }
  });
});
