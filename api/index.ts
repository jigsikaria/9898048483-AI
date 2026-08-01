import app from '../src/index.ts';

/**
 * Vercel serverless entry. Vercel rewrites every path to /api/index, so we
 * restore the original request path from the `x-vercel-rewrite` header before
 * handing off to the Hono app. Env vars (ANTHROPIC_API_KEY, etc.) are read
 * lazily by src/config.ts at each invocation, so Vercel env bindings work.
 */
async function handle(raw: Request): Promise<Response> {
  const rewrite = raw.headers.get('x-vercel-rewrite');
  let req = raw;

  if (rewrite && raw.url.includes('/api/index')) {
    const url = new URL(raw.url);
    const restored = new URL(rewrite, url.origin);
    restored.search = url.search;
    req = new Request(restored.toString(), raw);
  }

  return app.fetch(req);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
