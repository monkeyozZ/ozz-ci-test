import { lookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { RegistryAdapterError } from './contracts.js';

// Node's BlockList matches IPv4 addresses against mapped IPv6 ranges too.
// Keep families separate so blocking ::ffff:0:0/96 does not block public IPv4.
const privateIpv4 = new BlockList();
const privateIpv6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  privateIpv4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  privateIpv6.addSubnet(address, prefix, 'ipv6');

export function publicRedirectAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !privateIpv4.check(address, 'ipv4')
    : family === 6 && !privateIpv6.check(address, 'ipv6');
}

/** Bind the TLS connection to the checked DNS answer; do not re-resolve after checking it. */
export const publicRedirectLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    if (!addresses.length || addresses.some((entry) => !publicRedirectAddress(entry.address))) {
      callback(new RegistryAdapterError('REGISTRY_REDIRECT_REJECTED'), '', 0);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};
