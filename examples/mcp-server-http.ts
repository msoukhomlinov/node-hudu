/**
 * mcp-server-http.ts — a REMOTE, MULTI-USER MCP v2 server backed by node-hudu.
 *
 * `examples/mcp-server.ts` is a stdio server: one process, one Hudu credential from `HUDU_API_KEY`.
 * A remote server serves many callers at once, and each caller has to use its OWN credential. The
 * MCP v2 SDK's Resource-Server path supports exactly that:
 *
 *   caller's bearer token -> requireBearerAuth(verifier) -> AuthInfo -> handler.fetch(request, { authInfo })
 *                                                                          |
 *                                                                          v
 *                                        hudu.withAuth(new ApiKeyAuth(perUserKey))   (per request)
 *
 * SPLIT OF DUTY — the part that surprises people:
 * - The HOST verifies the caller's token. The `verifier` below is a STUB; replace it with your IdP's
 *   introspection endpoint (RFC 7662) or your own JWT check.
 * - The MCP SDK passes the verified `AuthInfo` through, untouched, to the factory that builds one
 *   `McpServer` per HTTP request (`ctx.authInfo`). The SDK verifies nothing itself.
 * - node-hudu SENDS the credential. It NEVER performs the OAuth dance: no authorization request, no
 *   token exchange, no refresh. It only produces request headers, at most once per attempt.
 *
 * WHY A SCOPED CLIENT, NOT A PER-CALL ARGUMENT
 * The credential stays in the server's per-request context and NEVER enters a tool's `inputSchema`:
 * a model must not be able to supply (or see) a Hudu credential, and no tool signature changes.
 * `shared.withAuth(...)` returns a real `HuduClient` that shares the process-wide client's transport
 * state — one rate-limit bucket, one queue, one logger, one audit hook — and differs only in its
 * credential. Two callers in flight therefore cannot see each other's key, and the tenant's rate
 * limit is still honoured across all of them.
 *
 * Env knobs:
 *   HUDU_BASE_URL   (required) the Hudu origin the shared client points at.
 *   PORT            (default 8787) the HTTP listener.
 *   HUDU_CREDENTIAL_MODE  (default 'api-key') 'api-key' sends the caller's own Hudu API key as
 *                   `x-api-key`; 'bearer' forwards the caller's own verified token as
 *                   `Authorization: Bearer ...` for a deployment that fronts Hudu with a
 *                   bearer-accepting proxy.
 *   HUDU_USER_KEYS  (optional) JSON map of session token -> that user's Hudu API key. The STUB
 *                   stand-in for a real identity lookup; with it unset, no token verifies.
 *
 * Run with:  HUDU_BASE_URL=https://hudu.example.com HUDU_USER_KEYS='{"<session>":"<key>"}' \
 *              npx tsx examples/mcp-server-http.ts
 * Requires:  npm install @modelcontextprotocol/server zod      (both are devDependencies here)
 *
 * Note: MCP SDK v2 requires Node >= 20.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import type { AuthInfo, McpServerFactory, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ApiKeyAuth, BearerTokenAuth, HuduClient } from 'node-hudu';
import { Operations } from 'node-hudu/operations';

const baseUrl = process.env.HUDU_BASE_URL;
if (!baseUrl) throw new Error('HUDU_BASE_URL is required (the Hudu origin, e.g. https://hudu.example.com)');
const port = Number(process.env.PORT ?? 8787);
/** 'api-key' (default) or 'bearer' — see the env knob list above. */
const credentialMode = process.env.HUDU_CREDENTIAL_MODE ?? 'api-key';

/**
 * STUB — a per-user credential directory.
 *
 * Replace this with your own lookup: IdP introspection, a tenant database, or a vault read keyed by
 * the token's `sub`/`clientId`. The SHAPE is what matters: a VERIFIED token resolves to that caller's
 * own Hudu credential, and nothing global is shared.
 */
const userApiKeys = new Map<string, string>(
  Object.entries(JSON.parse(process.env.HUDU_USER_KEYS ?? '{}') as Record<string, string>),
);

/**
 * STUB OAuth 2.1 Resource-Server verifier. The host owns this step; the SDK never presents this
 * token to Hudu. `requireBearerAuth` maps a thrown `invalid_token` to 401 with a
 * `WWW-Authenticate: Bearer ...` challenge, and a missing scope to 403 `insufficient_scope`.
 */
const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const huduApiKey = userApiKeys.get(token);
    if (!huduApiKey) throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown access token');
    return {
      token,
      clientId: 'hudu-mcp',
      scopes: ['mcp'],
      // Bearer verification rejects a token whose `expiresAt` is unset, so populate one.
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      // `extra` is the documented carrier for additional verified data — here, the caller's own Hudu
      // credential. It is server-side data; it is never returned to the model.
      extra: { huduApiKey },
    };
  },
};

/**
 * ONE process-wide client: one rate-limit bucket, one queue, one logger, one audit hook, shared by
 * every per-request scope. Its own strategy FAILS CLOSED, so a request that somehow escaped its
 * scope cannot be sent with a missing, default, or borrowed credential: it throws `AUTH_ERROR`
 * before anything reaches the wire.
 */
const shared = new HuduClient({
  baseUrl,
  auth: {
    name: 'unscoped',
    headers() {
      throw new Error('this client is a transport shell: scope it with withAuth(...) before use');
    },
  },
});

/** The caller's own Hudu credential, carried on the VERIFIED token. */
function perUserKey(authInfo: AuthInfo | undefined): string {
  const key = authInfo?.extra?.['huduApiKey'];
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new Error('the verified token does not carry a Hudu credential for this caller');
  }
  return key;
}

type ToolReturn =
  | { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }
  | { content: Array<{ type: 'text'; text: string }>; isError: true };

/** A successful structured result. `outputSchema` describes `structuredContent`. */
function ok(text: string, structuredContent: Record<string, unknown>): ToolReturn {
  return { content: [{ type: 'text', text }], structuredContent };
}

/** Surface `HuduError.code` so the model can correct itself. Credentials never appear in it. */
function errorContent(err: unknown): ToolReturn {
  const code = (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: JSON.stringify({ error: true, code, message }) }], isError: true };
}

const LIMIT = z.number().int().min(1).max(25).default(10).describe('Maximum hits per resource (1-25, default 10).');

/**
 * One `McpServer` per HTTP request, each backed by a client scoped to THAT caller.
 *
 * `ctx.authInfo` is the verified identity the host handed to `handler.fetch(request, { authInfo })`.
 * The tool definitions below are the same for every caller: only the credential differs, so the
 * tool surface is global and the data access is per caller.
 */
const factory: McpServerFactory = (ctx) => {
  // The whole credential story of this server is these three lines. A bare string handed to
  // `withAuth` would mean an API key, so a token is always passed explicitly.
  const authInfo = ctx.authInfo;
  const scoped =
    credentialMode === 'bearer'
      ? shared.withAuth(new BearerTokenAuth(authInfo!.token)) // caller's token, for a fronting proxy
      : shared.withAuth(new ApiKeyAuth(perUserKey(authInfo))); // caller's own Hudu API key
  const ops = new Operations(scoped);

  const server = new McpServer({
    name: 'hudu-mcp-http',
    version: '0.4.0',
    title: 'Hudu MCP Server (remote, per-caller credentials)',
  });

  server.registerTool(
    'hudu_search',
    {
      title: 'Search Hudu',
      description: 'Search the caller\'s Hudu tenant across its searchable resources and return ranked hits. The caller\'s own Hudu credential is resolved by the server for this request; it is NOT a tool argument and must never be supplied by a model.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Text to search for.'),
        limit: LIMIT,
      }),
      outputSchema: z.object({ query: z.string(), hits: z.array(z.unknown()), total: z.number() }).passthrough(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const hits = await ops.searchAcrossResources(args.query, { limit: args.limit });
        return ok(`${hits.length} hit(s) in this caller's tenant.`, {
          query: args.query,
          hits: hits as unknown[],
          total: hits.length,
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  return server;
};

/** One handler for both protocol eras; a fresh instance is built per HTTP request. */
const handler = createMcpHandler(factory);

/** The Resource-Server gate. A token without `mcp` is refused with 403 `insufficient_scope`. */
const gate = requireBearerAuth({ verifier, requiredScopes: ['mcp'] });

/**
 * A web-standard fetch handler — hand it to any fetch-shaped host (Cloudflare Workers, Deno, Bun,
 * Hono, or the Node bridge below).
 *
 * The host verifies; the SDK sends. `authInfo` is pass-through data: `createMcpHandler` never
 * derives it from a header and never verifies it.
 */
export async function fetchHandler(request: Request): Promise<Response> {
  const auth: AuthInfo | Response = await gate(request);
  if (auth instanceof Response) return auth; // 401 / 403, with the WWW-Authenticate challenge
  return handler.fetch(request, { authInfo: auth });
}

/** The smallest Node bridge to a fetch handler (Node has no fetch-shaped HTTP server). */
async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${port}`}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else if (value !== undefined) headers.set(name, value);
  }
  if (req.method === 'GET' || req.method === 'HEAD') return new Request(url, { method: req.method, headers });
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return new Request(url, { method: req.method, headers, body: Buffer.concat(chunks).toString('utf8') });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer((req, res) => {
  void toWebRequest(req)
    .then(fetchHandler)
    .then((response) => send(res, response))
    .catch((err: unknown) => {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : 'internal error');
    });
}).listen(port, () => {
  console.log(`Hudu MCP (HTTP) listening on http://localhost:${port} — bearer token required.`);
});
