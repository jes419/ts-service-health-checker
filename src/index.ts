
import express, { Request, Response, NextFunction } from 'express';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';

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

function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);

    if (parsed.kind() === 'ipv6') {
      const ipv6 = parsed as ipaddr.IPv6;

      if (ipv6.isIPv4MappedAddress()) {
        const mapped = ipv6.toIPv4Address();
        return mapped.range() === 'unicast';
      }
    }

    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

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

  const startedAt = Date.now();

  try {
    const addresses = await lookup(hostname, {
      all: true,
      verbatim: true
    });

    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => !isPublicAddress(address))
    ) {
      res.status(403).json({
        status: 'ERROR',
        message: 'The target host resolves to a prohibited IP address.'
      });
      return;
    }

    const selectedAddress = addresses[0];

    const result = await new Promise<{
      httpStatus: number;
      durationMs: number;
    }>((resolve, reject) => {
      const transport = targetUrl.protocol === 'https:' ? https : http;
      const controller = new AbortController();
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;

      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      timeout = setTimeout(() => {
        controller.abort();
        finishError(new Error('Request timed out.'));
      }, REQUEST_TIMEOUT_MS);

      const requestOptions: http.RequestOptions | https.RequestOptions = {
        protocol: targetUrl.protocol,
        hostname,
        port: targetUrl.port
          ? Number(targetUrl.port)
          : targetUrl.protocol === 'https:'
            ? 443
            : 80,
        method: 'GET',
        path: `${targetUrl.pathname}${targetUrl.search}`,
        signal: controller.signal,
        headers: {
          Host: targetUrl.host,
          Connection: 'close'
        },
        lookup: ((
          _host: string,
          _options: unknown,
          callback: (...args: unknown[]) => void
        ) => {
          callback(
            null,
            selectedAddress.address,
            selectedAddress.family
          );
        }) as never,
        servername: targetUrl.protocol === 'https:' ? hostname : undefined
      };

      const outgoing = transport.request(requestOptions, (incoming) => {
        const httpStatus = incoming.statusCode || 0;

        incoming.on('error', finishError);

        incoming.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({
            httpStatus,
            durationMs: Date.now() - startedAt
          });
        });

        incoming.resume();
      });

      outgoing.on('error', finishError);
      outgoing.end();
    });

    res.status(200).json({
      status:
        result.httpStatus >= 200 && result.httpStatus < 400 ? 'UP' : 'DOWN',
      target: targetUrl.origin,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && error.message === 'Request timed out.';

    res.status(200).json({
      status: 'DOWN',
      target: targetUrl.origin,
      error: timedOut
        ? 'Request timed out.'
        : 'Target service could not be reached.',
      durationMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString()
    });
  }
});

app.use(
  (
    _error: Error,
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    if (res.headersSent) return;

    res.status(500).json({
      status: 'ERROR',
      message: 'An internal server error occurred.'
    });
  }
);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `[SERVER] Health check microservice running on port ${PORT}`
    );
  });
}

export { app, isPublicAddress };