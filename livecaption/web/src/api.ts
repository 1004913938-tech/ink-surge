export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8000";

export interface HostSession {
  session_id: string;
  mode: "broadcast" | "personal";
  room: string;
  join_code: string | null; // null in personal mode
  join_url: string | null;
  livekit_url: string;
  src_lang: string;
  remote_lang: string | null;
  targets: string[];
  host_token: string;
}

export interface JoinInfo {
  livekit_url: string;
  room: string;
  title: string;
  src_lang: string;
  targets: string[];
  token: string;
}

async function check<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export function createSession(apiKey: string, body: {
  title: string; host_name: string; src_lang: string; targets: string[]; glossary?: Record<string, string>;
  mode?: "broadcast" | "personal"; remote_lang?: string;
}): Promise<HostSession> {
  return fetch(`${API_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify(body),
  }).then((r) => check<HostSession>(r));
}

export function joinSession(code: string, langs: string[]): Promise<JoinInfo> {
  return fetch(`${API_URL}/api/join/${encodeURIComponent(code)}?langs=${encodeURIComponent(langs.join(","))}`)
    .then((r) => check<JoinInfo>(r));
}

export function endSession(apiKey: string, id: string): Promise<unknown> {
  return fetch(`${API_URL}/api/sessions/${id}/end`, { method: "POST", headers: { "X-Api-Key": apiKey } })
    .then((r) => check(r));
}

export const LANG_LABEL: Record<string, string> = {
  zh: "中文", en: "English", id: "Bahasa Indonesia", ja: "日本語", ko: "한국어", th: "ไทย", vi: "Tiếng Việt", ms: "Bahasa Melayu",
  es: "Español", fr: "Français", de: "Deutsch", pt: "Português", ru: "Русский", ar: "العربية", hi: "हिन्दी",
};

export interface ServerConfig { stt: string; auto_lang: boolean; lang_hints: string[] }

export function serverConfig(): Promise<ServerConfig> {
  return fetch(`${API_URL}/api/config`).then((r) => check<ServerConfig>(r));
}
