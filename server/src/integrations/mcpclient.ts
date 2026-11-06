import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../records.js";

/** A client for a remote MCP server over Streamable HTTP, signed in with
 *  OAuth 2.1 the way the MCP spec describes: protected-resource metadata,
 *  authorization-server metadata, dynamic client registration, then the
 *  authorization-code flow with PKCE. Robinhood's Trading MCP works this way. */
export type OAuthState = {
  resource: string; authorizationEndpoint: string; tokenEndpoint: string; clientId: string; clientSecret?: string; redirectUri: string; scope?: string;
  access?: string; refresh?: string; expiresAt?: number;
};
const b64url = (b: Buffer) => b.toString("base64url");
async function getJson(url: string) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new HttpError(502, `${new URL(url).host} answered ${r.status} for ${new URL(url).pathname}.`);
  return r.json() as Promise<any>;
}

/** Step 1: find the authorization server for an MCP URL and register Orb as a client. */
export async function discover(mcpUrl: string, redirectUri: string, clientName = "Pondering Orb"): Promise<OAuthState> {
  const u = new URL(mcpUrl);
  // The server says where its metadata is in WWW-Authenticate on a 401; else the well-known path.
  let metaUrl = `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, "")}`;
  try {
    const probe = await fetch(mcpUrl, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }), signal: AbortSignal.timeout(15000) });
    const m = /resource_metadata="([^"]+)"/.exec(probe.headers.get("www-authenticate") || ""); if (m) metaUrl = m[1];
  } catch { /* fall back to the well-known path */ }
  let prm: any; try { prm = await getJson(metaUrl); } catch { prm = await getJson(`${u.origin}/.well-known/oauth-protected-resource`); }
  const as = String(prm.authorization_servers?.[0] || u.origin).replace(/\/$/, "");
  const asUrl = new URL(as);
  const tries = [`${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname === "/" ? "" : asUrl.pathname}`, `${asUrl.origin}/.well-known/openid-configuration${asUrl.pathname === "/" ? "" : asUrl.pathname}`, `${as}/.well-known/openid-configuration`];
  let meta: any = null; for (const t of tries) { try { meta = await getJson(t); break; } catch { /* next */ } }
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw new HttpError(502, "Couldn't find the sign-in server's details.");
  if (!meta.registration_endpoint) throw new HttpError(502, "The sign-in server doesn't allow new apps to register themselves.");
  const reg = await fetch(meta.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  const c: any = await reg.json().catch(() => ({}));
  if (!reg.ok || !c.client_id) throw new HttpError(502, `Registering Orb with the sign-in server failed (${reg.status}${c.error_description ? ": " + c.error_description : ""}).`);
  return { resource: prm.resource || mcpUrl, authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint, clientId: c.client_id, clientSecret: c.client_secret, redirectUri,
    scope: Array.isArray(prm.scopes_supported) ? prm.scopes_supported.join(" ") : undefined };
}

/** Step 2: the address to send the person to, plus the PKCE verifier to keep. */
export function authorizeUrl(o: OAuthState) {
  const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(24));
  const q = new URLSearchParams({ response_type: "code", client_id: o.clientId, redirect_uri: o.redirectUri, state, resource: o.resource,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", ...(o.scope ? { scope: o.scope } : {}) });
  return { url: `${o.authorizationEndpoint}?${q}`, verifier, state };
}

async function tokenCall(o: OAuthState, form: Record<string, string>) {
  const body = new URLSearchParams({ client_id: o.clientId, resource: o.resource, ...(o.clientSecret ? { client_secret: o.clientSecret } : {}), ...form });
  const r = await fetch(o.tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, signal: AbortSignal.timeout(15000) });
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new HttpError(r.status === 400 || r.status === 401 ? 401 : 502, `Sign-in failed (${t.error_description || t.error || r.status}).`);
  return { ...o, access: t.access_token, refresh: t.refresh_token || o.refresh, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 } as OAuthState;
}
/** Step 3: the code from the redirect, exchanged for tokens. */
export const exchange = (o: OAuthState, code: string, verifier: string) => tokenCall(o, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: o.redirectUri });
export const refresh = (o: OAuthState) => { if (!o.refresh) throw new HttpError(401, "Signed out of Robinhood; connect again."); return tokenCall(o, { grant_type: "refresh_token", refresh_token: o.refresh }); };

export type McpTool = { name: string; description?: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } };

/** JSON-RPC over Streamable HTTP. Answers may be JSON or an SSE stream. */
export class McpClient {
  private session = ""; private nextId = 1; private ready = false; private sessionFor = "";
  constructor(private urlOf: () => string, private auth: () => Promise<string>, private onUnauthorized: () => Promise<void>) {}
  private async post(msg: any, retry = true): Promise<any> {
    const url = this.urlOf(); if (url !== this.sessionFor) { this.session = ""; this.ready = false; this.sessionFor = url; }
    const r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(60000), headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${await this.auth()}`, ...(this.session ? { "Mcp-Session-Id": this.session } : {}) }, body: JSON.stringify(msg) });
    if (r.status === 401 && retry) { await this.onUnauthorized(); return this.post(msg, false); }
    if (r.status === 404 && this.session && retry) { this.session = ""; this.ready = false; await this.init(); return this.post(msg, false); }
    if (!r.ok && r.status !== 202) throw new HttpError(502, `The MCP server answered ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const sid = r.headers.get("mcp-session-id"); if (sid) this.session = sid;
    if (msg.id === undefined || r.status === 202) return null;
    const type = r.headers.get("content-type") || "", text = await r.text();
    const msgs = type.includes("text/event-stream") ? text.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }) : [JSON.parse(text || "null")];
    const res = msgs.find(m => m && m.id === msg.id);
    if (!res) throw new HttpError(502, "The MCP server sent no answer.");
    if (res.error) throw new HttpError(502, `The MCP server refused: ${res.error.message || JSON.stringify(res.error)}`);
    return res.result;
  }
  private async init() {
    if (this.ready && this.sessionFor === this.urlOf()) return;
    await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pondering-orb", version: "0.1.0" } } });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.ready = true;
  }
  async tools(): Promise<McpTool[]> { await this.init(); return (await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} }))?.tools || []; }
  async call(name: string, args: Record<string, unknown>) {
    await this.init();
    const r = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
    const text = (r?.content || []).map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
    return { isError: !!r?.isError, text, structured: r?.structuredContent };
  }
  reset() { this.session = ""; this.ready = false; }
}
