/**
 * Reject requests from other sites (Origin) and DNS rebinding (Host), since any
 * page the user visits could otherwise drive POST /message or the WebSocket,
 * which types into Claude sessions via tmux.
 */
export function isTrusted(req: Request, localHostnames: Set<string>): boolean {
  const url = new URL(req.url);
  if (!localHostnames.has(url.hostname)) return false;
  const origin = req.headers.get("origin");
  if (!origin) return true; // curl and same-origin GETs send no Origin
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}
