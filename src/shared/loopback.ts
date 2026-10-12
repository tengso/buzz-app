/** Plain http/ws is acceptable only when the traffic never leaves this machine
 * (for example a relay reached through an SSH tunnel). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function isSecureOrLoopbackHref(value: string): boolean {
  try {
    return isSecureOrLoopbackUrl(new URL(value));
  } catch {
    return false;
  }
}

/** https anywhere, or http on a loopback host. */
export function isSecureOrLoopbackUrl(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopbackHost(url.hostname))
  );
}
