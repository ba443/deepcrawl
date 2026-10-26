import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import type { AppBindings, AppContext } from '@/lib/context';

/**
 * Minimal single-user OAuth 2.1 authorization server for the MCP endpoint
 * (AUTH_MODE=jwt). Stateless: codes and refresh tokens are HS256 JWTs signed
 * with JWT_SECRET, and access tokens are the same JWTs `jwtAuthMiddleware`
 * already accepts. The consent page is gated by MCP_OAUTH_PASSWORD.
 *
 * Codes and refresh tokens carry no `sub`, so they are rejected as API bearers.
 */

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 60;
const MIN_PASSWORD_LENGTH = 24;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/** Fixed callbacks for hosted MCP clients. Loopback is allowed for CLI clients. */
const ALLOWED_REDIRECT_URIS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isOAuthPublicPath(path: string) {
  return path.startsWith('/.well-known/oauth-') || path.startsWith('/oauth/');
}

export function isAllowedRedirectUri(raw: string) {
  if (ALLOWED_REDIRECT_URIS.has(raw)) {
    return true;
  }

  try {
    const url = new URL(raw);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
}

async function pkceChallenge(verifier: string) {
  return Buffer.from(await sha256(verifier)).toString('base64url');
}

/** Compares digests so the check does not leak length or prefix matches. */
async function safeEqual(a: string, b: string) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

async function verifyUse(
  token: unknown,
  secret: string,
  use: 'code' | 'refresh',
) {
  if (typeof token !== 'string' || !token) {
    return null;
  }

  try {
    const payload = await verify(token, secret, { alg: 'HS256' });
    return payload.use === use ? payload : null;
  } catch {
    return null;
  }
}

const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const;

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

function parseAuthorizeParams(
  get: (key: string) => string | undefined,
): { params: AuthorizeParams } | { error: string } {
  const redirectUri = get('redirect_uri') ?? '';
  const clientId = get('client_id') ?? '';
  const codeChallenge = get('code_challenge') ?? '';

  if (get('response_type') !== 'code') {
    return { error: 'response_type must be "code".' };
  }
  if (!clientId) {
    return { error: 'client_id is required.' };
  }
  if (!isAllowedRedirectUri(redirectUri)) {
    return { error: 'redirect_uri is not allowed.' };
  }
  if (
    get('code_challenge_method') !== 'S256' ||
    !PKCE_CHALLENGE_PATTERN.test(codeChallenge)
  ) {
    return { error: 'PKCE with code_challenge_method=S256 is required.' };
  }

  return {
    params: { clientId, redirectUri, codeChallenge, state: get('state') ?? '' },
  };
}

function consentPage(params: AuthorizeParams, error?: string) {
  const hidden = Object.entries({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  })
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Deepcrawl</title>
<style>
body{font-family:system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem;color:#111}
input[type=password]{width:100%;padding:.6rem;margin:.5rem 0 1rem;box-sizing:border-box}
button{padding:.6rem 1rem;width:100%}
.error{color:#b00020}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}
</style>
</head>
<body>
<h1>Authorize Deepcrawl</h1>
<p>An MCP client is requesting access to your Deepcrawl tools. Enter the access password to continue.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">
${hidden}
<label>Password<input type="password" name="password" autocomplete="current-password" autofocus required></label>
<button type="submit">Authorize</button>
</form>
</body>
</html>`;
}

const oauth = new Hono<AppBindings>();

const originOf = (url: string) => new URL(url).origin;

oauth.get('/.well-known/oauth-protected-resource/*', (c) =>
  protectedResource(c),
);
oauth.get('/.well-known/oauth-protected-resource', (c) => protectedResource(c));

function protectedResource(c: AppContext) {
  const origin = originOf(c.req.url);
  return c.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
  });
}

oauth.get('/.well-known/oauth-authorization-server/*', (c) => metadata(c));
oauth.get('/.well-known/oauth-authorization-server', (c) => metadata(c));

function metadata(c: AppContext) {
  const origin = originOf(c.req.url);
  return c.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

// Dynamic client registration. Stateless: redirect URIs are allowlisted, so
// the client_id carries no information.
oauth.post('/oauth/register', async (c) => {
  const body = await c.req.json().catch(() => null);
  const redirectUris: unknown = body?.redirect_uris;

  if (
    !(
      Array.isArray(redirectUris) &&
      redirectUris.length &&
      redirectUris.every(
        (uri) => typeof uri === 'string' && isAllowedRedirectUri(uri),
      )
    )
  ) {
    return c.json(
      {
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must all be allowed callbacks.',
      },
      400,
    );
  }

  return c.json(
    {
      client_id: `dc_${crypto.randomUUID()}`,
      client_id_issued_at: nowSeconds(),
      client_name:
        typeof body.client_name === 'string' ? body.client_name : undefined,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    201,
    noStore,
  );
});

oauth.get('/oauth/authorize', (c) => {
  if (!isConfigured(c.env)) {
    return c.text('MCP OAuth is not configured on this worker.', 503);
  }

  const parsed = parseAuthorizeParams((key) => c.req.query(key));
  if ('error' in parsed) {
    return c.text(parsed.error, 400);
  }

  return c.html(consentPage(parsed.params), 200, noStore);
});

oauth.post('/oauth/authorize', async (c) => {
  if (!isConfigured(c.env)) {
    return c.text('MCP OAuth is not configured on this worker.', 503);
  }

  const form = await c.req.parseBody();
  const field = (key: string) =>
    typeof form[key] === 'string' ? (form[key] as string) : undefined;

  const parsed = parseAuthorizeParams(field);
  if ('error' in parsed) {
    return c.text(parsed.error, 400);
  }

  const { params } = parsed;
  if (!(await safeEqual(field('password') ?? '', c.env.MCP_OAUTH_PASSWORD))) {
    return c.html(consentPage(params, 'Incorrect password.'), 401, noStore);
  }

  const iat = nowSeconds();
  const code = await sign(
    {
      use: 'code',
      cid: params.clientId,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      jti: crypto.randomUUID(),
      iat,
      exp: iat + CODE_TTL_S,
    },
    c.env.JWT_SECRET,
    'HS256',
  );

  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set('code', code);
  if (params.state) {
    redirect.searchParams.set('state', params.state);
  }

  return c.redirect(redirect.toString(), 302);
});

oauth.post('/oauth/token', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  const fail = (error: string, description: string) =>
    c.json({ error, error_description: description }, 400);

  if (!isConfigured(c.env)) {
    return fail('server_error', 'MCP OAuth is not configured.');
  }

  const form = await c.req.parseBody();
  const field = (key: string) =>
    typeof form[key] === 'string' ? (form[key] as string) : '';
  const secret = c.env.JWT_SECRET;
  const clientId = field('client_id');
  const grantType = field('grant_type');

  if (grantType === 'authorization_code') {
    const code = await verifyUse(field('code'), secret, 'code');
    if (
      !code ||
      code.cid !== clientId ||
      code.ru !== field('redirect_uri') ||
      !field('code_verifier') ||
      code.cc !== (await pkceChallenge(field('code_verifier')))
    ) {
      return fail('invalid_grant', 'Invalid or expired authorization code.');
    }
  } else if (grantType === 'refresh_token') {
    const refresh = await verifyUse(field('refresh_token'), secret, 'refresh');
    if (!refresh || refresh.cid !== clientId) {
      return fail('invalid_grant', 'Invalid or expired refresh token.');
    }
  } else {
    return fail('unsupported_grant_type', 'Unsupported grant_type.');
  }

  const iat = nowSeconds();
  const accessToken = await sign(
    {
      sub: 'mcp-oauth',
      iat,
      exp: iat + ACCESS_TTL_S,
      ...(c.env.JWT_ISSUER ? { iss: c.env.JWT_ISSUER } : {}),
      ...(c.env.JWT_AUDIENCE ? { aud: c.env.JWT_AUDIENCE } : {}),
    },
    secret,
    'HS256',
  );
  const refreshToken = await sign(
    {
      use: 'refresh',
      cid: clientId,
      jti: crypto.randomUUID(),
      iat,
      exp: iat + REFRESH_TTL_S,
    },
    secret,
    'HS256',
  );

  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refreshToken,
  });
});

function isConfigured(env: AppBindings['Bindings']) {
  return (
    !!env.JWT_SECRET &&
    typeof env.MCP_OAUTH_PASSWORD === 'string' &&
    env.MCP_OAUTH_PASSWORD.length >= MIN_PASSWORD_LENGTH
  );
}

export default oauth;
