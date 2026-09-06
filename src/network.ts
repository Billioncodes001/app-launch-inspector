import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "./errors.js";

export function allowedAddress(address: string) {
  if (address === "::1") return true;
  if (isIP(address) === 6) {
    const first = parseInt(address.split(":")[0], 16);
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      !address.toLowerCase().startsWith("2001:db8:") &&
      !address.toLowerCase().startsWith("2002:")
    );
  }
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  if (a === 127) return true;
  return !(
    a === 0 ||
    a === 10 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224 ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export async function targetPolicy(
  origin: string,
  forbiddenPorts: number[] = [],
  allowLoopback = true,
) {
  const url = new URL(origin),
    host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new HttpError(
      400,
      "Use a target origin without credentials or a path",
    );
  if (
    forbiddenPorts.includes(
      Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    ) &&
    ["localhost", "127.0.0.1", "::1"].includes(host)
  )
    throw new HttpError(
      400,
      "The inspector cannot inspect its own control server",
    );
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !allowedAddress(a.address)))
    throw new HttpError(
      400,
      "Private network, metadata and reserved destinations are not supported. Use a public staging host or a loopback test app.",
    );
  const selected = addresses.find((a) => a.family === 4) ?? addresses[0];
  if (
    !allowLoopback &&
    addresses.some((a) => a.address.startsWith("127.") || a.address === "::1")
  )
    throw new HttpError(
      400,
      "Hosted inspections cannot target loopback services",
    );
  if (
    forbiddenPorts.includes(
      Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    ) &&
    (selected.address.startsWith("127.") || selected.address === "::1")
  )
    throw new HttpError(
      400,
      "The inspector cannot inspect its own control server",
    );
  if (
    url.protocol === "http:" &&
    !["127.0.0.1", "::1"].includes(selected.address) &&
    !selected.address.startsWith("127.")
  )
    throw new HttpError(400, "Public staging targets must use HTTPS");
  return {
    origin: url.origin,
    resolverRule: isIP(host)
      ? undefined
      : `MAP ${host} ${selected.family === 6 ? "[" + selected.address + "]" : selected.address}, EXCLUDE localhost`,
    address: selected.address,
  };
}
export function inScope(url: string, origin: string) {
  try {
    const u = new URL(url);
    return (
      u.origin === origin &&
      !u.username &&
      !u.password &&
      ["http:", "https:"].includes(u.protocol)
    );
  } catch {
    return false;
  }
}
export function pathUrl(path: string, origin: string) {
  const url = new URL(path, origin);
  if (!inScope(url.href, origin))
    throw new HttpError(400, "The requested path leaves the authorized target");
  return url.href;
}
