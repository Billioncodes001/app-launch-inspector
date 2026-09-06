import type { SessionInfo } from "../../src/contracts";
let token =
  document.querySelector<HTMLMetaElement>('meta[name="inspector-token"]')
    ?.content ?? "";
let organization = "local";
export function setContext(session: SessionInfo, id: string) {
  token = session.csrf;
  organization = id;
}
export function headers(extra: Record<string, string> = {}) {
  return {
    "X-Inspector-Token": token,
    "X-Inspector-Organization": organization,
    ...extra,
  };
}
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    signal,
    headers: headers({
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extra,
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (response.status === 401)
    window.dispatchEvent(new Event("inspector-session-expired"));
  if (!response.ok) throw Error(result.error ?? "Request failed");
  return result;
}
