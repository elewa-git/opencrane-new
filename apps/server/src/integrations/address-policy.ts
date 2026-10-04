// Adapted from OC1 mcp-remote-client-address-policy.ts, commit 10abd0ef6182f36bec13d8f1358e43b15ead7cd5.
import { isIP } from "node:net";

type McpRemoteDnsAddress = { address: string; family: number };


/** Return whether an IPv4 address avoids every non-public special-purpose range. */
function _IsPublicIpv4(address: string): boolean {
  const value = address.split('.').reduce((n, octet) => (n * 256) + Number(octet), 0);
  const reserved = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 16], ['192.88.99.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
  ] as const;
  return !reserved.some(([base, bits]) => {
    const range = base.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
    return value >>> (32 - bits) === range >>> (32 - bits);
  });
}

/** Expand one valid IPv6 address into eight numeric groups. */
function _Ipv6Groups(address: string): readonly number[] | null
{
	if (address.includes("%"))
		return null;
	const split = address.split("::");
	if (split.length > 2)
		return null;
	const left = split[0] === "" ? [] : split[0]!.split(":");
	const right = split.length === 1 || split[1] === "" ? [] : split[1]!.split(":");
	const groups = [...left, ...right];
	if (groups.some(function _InvalidGroup(group) { return !/^[0-9a-f]{1,4}$/iu.test(group); }))
		return null;
	if (split.length === 1 && groups.length !== 8)
		return null;
	if (split.length === 2 && groups.length >= 8)
		return null;
	const values = groups.map(function _ParseGroup(group) { return Number.parseInt(group, 16); });
	if (split.length === 2)
		values.splice(left.length, 0, ...Array.from({ length: 8 - groups.length }, function _Zero() { return 0; }));
	return values.length === 8 ? values : null;
}

/** Return whether an IPv6 address is public global unicast and not a reserved subrange. */
function _IsPublicIpv6(address: string): boolean
{
	const groups = _Ipv6Groups(address);
	if (groups === null)
		return false;
	const first = groups[0]!;
	const second = groups[1]!;
	if (first < 0x2000 || first > 0x3fff)
		return false;
	if (first === 0x2001 && second <= 0x01ff)
		return false;
	if (first === 0x2001 && second === 0x0db8)
		return false;
	if (first === 0x2002 || first === 0x3ffe)
		return false;
	if (first === 0x3fff && (second & 0xf000) === 0)
		return false;
	return true;
}

/** Return whether one resolver result may be used for an outbound MCP connection. */
export function isPublicAddress(address: McpRemoteDnsAddress): boolean
{
	if (address.family === 4)
		return isIP(address.address) === 4 && _IsPublicIpv4(address.address);
	return isIP(address.address) === 6 && _IsPublicIpv6(address.address);
}

/** Parse the one direct HTTPS endpoint admitted by the transport. */
export function remoteEndpoint(value: string): URL
{
	if (!/^[^\s\\?#\p{Cc}]+$/u.test(value)) throw new Error("invalid_endpoint");
	let endpoint: URL;
	try { endpoint = new URL(value); }
	catch { throw new Error("invalid_endpoint"); }
	const hostname = endpoint.hostname.startsWith("[") && endpoint.hostname.endsWith("]") ? endpoint.hostname.slice(1, -1) : endpoint.hostname;
	if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.hash !== "" || endpoint.search !== "" || isIP(hostname) !== 0)
		throw new Error("invalid_endpoint");
	return endpoint;
}
