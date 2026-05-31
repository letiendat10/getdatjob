import { createHmac } from "crypto";

// HMAC-signed OAuth state — encodes `next` + a nonce, signed with a server secret.
// Self-verifying: no cookie needed, so browser ITP / privacy settings can't break the flow.
// State format: base64url(<nonce>|<next>).<hmac_hex_8bytes>

const secret = () =>
  process.env.OAUTH_STATE_SECRET ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "dev-fallback-secret-change-me";

function b64(s: string) {
  return Buffer.from(s).toString("base64url");
}
function unb64(s: string) {
  return Buffer.from(s, "base64url").toString("utf8");
}
function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex").slice(0, 16);
}

export function createOAuthState(nonce: string, next: string): string {
  const payload = b64(`${nonce}|${next}`);
  return `${payload}.${sign(payload)}`;
}

export type ParsedState = { nonce: string; next: string } | null;

export function verifyOAuthState(state: string): ParsedState {
  const dot = state.lastIndexOf(".");
  if (dot === -1) return null;
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (sign(payload) !== sig) return null;
  try {
    const decoded = unb64(payload);
    const pipe = decoded.indexOf("|");
    if (pipe === -1) return null;
    return { nonce: decoded.slice(0, pipe), next: decoded.slice(pipe + 1) };
  } catch {
    return null;
  }
}
