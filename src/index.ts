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
const TIMEOUT_MESSAGE = 'Request timed out.';

const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HEALTHCHECK_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean)
);

const ALLOWED_PORTS = new Set(
  (process.env.ALLOWED_HEALTHCHECK_PORTS || '80,443')
    .split(',')
    .map((port) => Number(port.trim()))
    .filter(Boolean)
);

const BLOCKED_IPV4_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4'
].map((range) => ipaddr.IPv4.parseCIDR(range));

const BLOCKED_IPV6_RANGES = [
  '::/128',
  '::/96',
  '::1/128',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/23',
  '2001:db8::/32',
  '2002::/16',
  '3fff::/20',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8'
].map((range) => ipaddr.IPv6.parseCIDR(range));

function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);

    if (parsed.kind() === 'ipv6') {
      const ipv6 = parsed as ipaddr.IPv6;

      if (ipv6.isIPv4MappedAddress()) {
        return isPublicAddress(ipv6.toIPv4Address().toString());
      }

      if (ipv6.range() !== 'unicast') {
        return false;
      }

      return !BLOCKED_IPV6_RANGES.some((range) => ipv6.match(range));
    }

    const ipv4 = parsed as ipaddr.IPv4;

    if (ipv4.range() !== 'unicast') {
      return false;
    }

    return !BLOCKED_IPV4_RANGES.some((range) => ipv4.match(range));
  } catch {
    return false;
  }
}

async function lookupWithTimeout(hostname: string, deadline: number) {
  const remaining = deadline - Date.now();

  if (remaining <= 0) {
    throw new Error(TIMEOUT_MESSAGE);
  }

  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), remaining);
  });

  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      timeoutPromise
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
    targetUrl.password ||
    targetUrl.hash
  ) {
    res.status(400).json({
      status: 'ERROR',
      message:
        'Only HTTP and HTTPS URLs without credentials or fragments are supported.'
    });
    return;
  }

  const hostname = targetUrl.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  if (
    !hostname ||
    !ALLOWED_HOSTS.has(hostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.invalid') ||
    hostname.endsWith('.example') ||
    isIP(hostname) !== 0
  ) {
    res.status(403).json({
      status: 'ERROR',
      message: 'The target host is not allowed.'
    });
    return;
  }

  const effectivePort = targetUrl.port
    ? Number(targetUrl.port)
    : targetUrl.protocol === 'https:'
      ? 443
      : 80;

  if (!ALLOWED_PORTS.has(effectivePort)) {
    res.status(403).json({
      status: 'ERROR',
      message: 'The target port is not allowed.'
    });
    return;
  }

  const startedAt = Date.now();
  const deadline = startedAt + REQUEST_TIMEOUT_MS;

  try {
    const addresses = await lookupWithTimeout(hostname, deadline);

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
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      throw new Error(TIMEOUT_MESSAGE);
    }

    const result = await new Promise<{
      httpStatus: number;
      durationMs: number;
    }>((resolve, reject) => {
      const transport = targetUrl.protocol === 'https:' ? https : http;
      const controller = new AbortController();
      let settled = false;

      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      const timeout = setTimeout(() => {
        finishError(new Error(TIMEOUT_MESSAGE));
        controller.abort();
      }, remainingMs);

      const requestOptions: http.RequestOptions | https.RequestOptions = {
        protocol: targetUrl.protocol,
        hostname,
        port: effectivePort,
        method: 'GET',
        path: `${targetUrl.pathname}${targetUrl.search}`,
        signal: controller.signal,
        agent: false,
        headers: {
          Host: targetUrl.host,
          Connection: 'close'
        },
        lookup: ((
          _host: string,
          options: { all?: boolean } | undefined,
          callback: (...args: unknown[]) => void
        ) => {
          if (options && options.all) {
            callback(null, [
              {
                address: selectedAddress.address,
                family: selectedAddress.family
              }
            ]);
            return;
          }

          callback(
            null,
            selectedAddress.address,
            selectedAddress.family
          );
        }) as never,
        servername:
          targetUrl.protocol === 'https:' ? hostname : undefined
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
        result.httpStatus >= 200 && result.httpStatus < 400
          ? 'UP'
          : 'DOWN',
      target: targetUrl.origin,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && error.message === TIMEOUT_MESSAGE;

    res.status(200).json({
      status: 'DOWN',
      target: targetUrl.origin,
      error: timedOut
        ? TIMEOUT_MESSAGE
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