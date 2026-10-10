
import express, { Request, Response, NextFunction } from 'express';
import { isIP } from 'node:net';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const REQUEST_TIMEOUT_MS = Math.min(
  30000,
  Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS) || 5000)
);
const SERVICE_NAME = 'ts-service-health-checker';
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HEALTHCHECK_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean)
);

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    service: SERVICE_NAME,
    uptime: process.uptime()
  });
});

app.get('/health/check', async (req: Request, res: Response) => {
  const target = req.query.url;

  if (typeof target !== 'string' || !target.trim()) {
    res.status(400).json({
      status: 'ERROR',
      message: 'A target URL query parameter is required.'
    });
    return;
  }

  let targetUrl: URL;

  try {
    targetUrl = new URL(target);
  } catch {
    res.status(400).json({
      status: 'ERROR',
      message: 'The target URL is invalid.'
    });
    return;
  }

  if (
    !['http:', 'https:'].includes(targetUrl.protocol) ||
    targetUrl.username ||
    targetUrl.password
  ) {
    res.status(400).json({
      status: 'ERROR',
      message: 'Only HTTP and HTTPS URLs without credentials are supported.'
    });
    return;
  }

  const hostname = targetUrl.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  if (
    !ALLOWED_HOSTS.has(hostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    isIP(hostname) !== 0
  ) {
    res.status(403).json({
      status: 'ERROR',
      message: 'The target host is not allowed.'
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual'
    });

    res.status(200).json({
      status: response.status >= 200 && response.status < 400 ? 'UP' : 'DOWN',
      target: targetUrl.origin,
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';

    res.status(200).json({
      status: 'DOWN',
      target: targetUrl.origin,
      error: timedOut ? 'Request timed out.' : 'Target service could not be reached.',
      durationMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString()
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.use((_error: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    status: 'ERROR',
    message: 'An internal server error occurred.'
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[SERVER] Health check microservice running on port ${PORT}`);
  });
}

export { app };
