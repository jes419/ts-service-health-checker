import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { lookupMock, httpsRequestMock } = vi.hoisted(() => {
  process.env.ALLOWED_HEALTHCHECK_HOSTS =
    'api.allowed-host.com,localhost,127.0.0.1,service.internal';
  process.env.REQUEST_TIMEOUT_MS = '1000';

  return {
    lookupMock: vi.fn(),
    httpsRequestMock: vi.fn()
  };
});

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
  default: { lookup: lookupMock }
}));

vi.mock('node:https', () => ({
  request: httpsRequestMock,
  default: { request: httpsRequestMock }
}));

import { app, isPublicAddress } from './index';

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 };
const TARGET = 'https://api.allowed-host.com/health';

function mockHttpsResponse(statusCode: number) {
  httpsRequestMock.mockImplementation((_options: unknown, callback: any) => {
    const req: any = new EventEmitter();

    req.end = () => {
      const res: any = new EventEmitter();
      res.statusCode = statusCode;
      res.resume = () => {
        setImmediate(() => res.emit('end'));
      };
      callback(res);
    };

    return req;
  });
}

function mockHttpsHang() {
  httpsRequestMock.mockImplementation(() => {
    const req: any = new EventEmitter();
    req.end = vi.fn();
    return req;
  });
}

function mockHttpsError() {
  httpsRequestMock.mockImplementation(() => {
    const req: any = new EventEmitter();
    req.end = () => {
      setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
    };
    return req;
  });
}

beforeEach(() => {
  lookupMock.mockReset();
  httpsRequestMock.mockReset();
});

describe('Health Check API', () => {
  it('returns UP from the health endpoint', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('UP');
    expect(response.body.service).toBe('ts-service-health-checker');
    expect(response.body.uptime).toEqual(expect.any(Number));
  });

  it('returns 400 when the target URL is missing', async () => {
    const response = await request(app).get('/health/check');

    expect(response.status).toBe(400);
    expect(response.body.status).toBe('ERROR');
  });

  it('returns 400 when the target URL is invalid', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'not-a-valid-url' });

    expect(response.status).toBe(400);
    expect(response.body.status).toBe('ERROR');
  });

  it('rejects unsupported URL protocols', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'ftp://example.com' });

    expect(response.status).toBe(400);
    expect(response.body.status).toBe('ERROR');
  });

  it('rejects hosts outside the allowlist', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'https://google.com' });

    expect(response.status).toBe(403);
    expect(response.body.status).toBe('ERROR');
    expect(response.body.message).toBe('The target host is not allowed.');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects URLs containing credentials', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'https://user:password@example.com' });

    expect(response.status).toBe(400);
    expect(response.body.status).toBe('ERROR');
  });

  it('rejects duplicate URL query parameters', async () => {
    const response = await request(app).get(
      '/health/check?url=https%3A%2F%2Fexample.com&url=https%3A%2F%2Fgoogle.com'
    );

    expect(response.status).toBe(400);
    expect(response.body.status).toBe('ERROR');
  });

  it('rejects URL fragments', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'https://example.com/#section' });

    expect(response.status).toBe(400);
    expect(response.body.status).toBe('ERROR');
  });
});

describe('Hostname and port restrictions', () => {
  it('rejects localhost even when it is allowlisted', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'https://localhost/health' });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('The target host is not allowed.');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects IP literals even when they are allowlisted', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'https://127.0.0.1/health' });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('The target host is not allowed.');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects internal suffixes even when they are allowlisted', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'https://service.internal/health' });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('The target host is not allowed.');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects IPv6 literals', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'https://[::1]/health' });

    expect(response.status).toBe(403);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects decimal IPv4 literals', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'http://2130706433/' });

    expect(response.status).toBe(403);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects ports outside the allowed list', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'https://api.allowed-host.com:6379/' });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('The target port is not allowed.');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects non-default ports such as 8443', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'https://api.allowed-host.com:8443/' });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('The target port is not allowed.');
  });
});

describe('DNS resolution checks', () => {
  it('rejects allowlisted hosts that resolve to loopback', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe(
      'The target host resolves to a prohibited IP address.'
    );
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('rejects allowlisted hosts that resolve to private ranges', async () => {
    lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(403);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('rejects the cloud metadata address', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(403);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('rejects when any resolved address is private', async () => {
    lookupMock.mockResolvedValue([
      PUBLIC_ADDRESS,
      { address: '192.168.1.10', family: 4 }
    ]);

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(403);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('rejects IPv4-mapped IPv6 private results', async () => {
    lookupMock.mockResolvedValue([
      { address: '::ffff:10.0.0.5', family: 6 }
    ]);

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(403);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('rejects empty DNS results', async () => {
    lookupMock.mockResolvedValue([]);

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(403);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('returns DOWN when DNS lookup fails', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('DOWN');
    expect(response.body.error).toBe('Target service could not be reached.');
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});

describe('Outgoing request behavior', () => {
  it('returns UP for a 200 response', async () => {
    lookupMock.mockResolvedValue([PUBLIC_ADDRESS]);
    mockHttpsResponse(200);

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('UP');
    expect(response.body.httpStatus).toBe(200);
    expect(response.body.target).toBe('https://api.allowed-host.com');
    expect(response.body.durationMs).toEqual(expect.any(Number));
  });

  it('returns DOWN for a 500 response', async () => {
    lookupMock.mockResolvedValue([PUBLIC_ADDRESS]);
    mockHttpsResponse(500);

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('DOWN');
    expect(response.body.httpStatus).toBe(500);
  });

  it('does not follow redirects', async () => {
    lookupMock.mockResolvedValue([PUBLIC_ADDRESS]);
    mockHttpsResponse(302);

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(200);
    expect(response.body.httpStatus).toBe(302);
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  });

  it('returns DOWN when the connection fails', async () => {
    lookupMock.mockResolvedValue([PUBLIC_ADDRESS]);
    mockHttpsError();

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('DOWN');
    expect(response.body.error).toBe('Target service could not be reached.');
  });

  it('pins the validated IP address and disables agent reuse', async () => {
    lookupMock.mockResolvedValue([PUBLIC_ADDRESS]);
    mockHttpsResponse(200);

    await request(app).get('/health/check').query({ url: TARGET });

    expect(httpsRequestMock).toHaveBeenCalledTimes(1);

    const options = httpsRequestMock.mock.calls[0][0];

    expect(options.hostname).toBe('api.allowed-host.com');
    expect(options.port).toBe(443);
    expect(options.agent).toBe(false);
    expect(options.servername).toBe('api.allowed-host.com');
    expect(options.method).toBe('GET');

    const singleCallback = vi.fn();
    options.lookup('api.allowed-host.com', {}, singleCallback);
    expect(singleCallback).toHaveBeenCalledWith(
      null,
      PUBLIC_ADDRESS.address,
      PUBLIC_ADDRESS.family
    );

    const allCallback = vi.fn();
    options.lookup('api.allowed-host.com', { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [
      { address: PUBLIC_ADDRESS.address, family: PUBLIC_ADDRESS.family }
    ]);
  });

  it('passes only the path and query string to the outgoing request', async () => {
    lookupMock.mockResolvedValue([PUBLIC_ADDRESS]);
    mockHttpsResponse(200);

    await request(app)
      .get('/health/check')
      .query({ url: 'https://api.allowed-host.com/status?verbose=1' });

    const options = httpsRequestMock.mock.calls[0][0];

    expect(options.path).toBe('/status?verbose=1');
    expect(options.headers.Host).toBe('api.allowed-host.com');
  });
});

describe('Timeout behavior', () => {
  it('times out when DNS lookup never resolves', async () => {
    lookupMock.mockImplementation(() => new Promise(() => {}));

    const startedAt = Date.now();

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('DOWN');
    expect(response.body.error).toBe('Request timed out.');
    expect(httpsRequestMock).not.toHaveBeenCalled();
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2000);
  }, 10000);

  it('times out when the target never responds', async () => {
    lookupMock.mockResolvedValue([PUBLIC_ADDRESS]);
    mockHttpsHang();

    const startedAt = Date.now();

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('DOWN');
    expect(response.body.error).toBe('Request timed out.');
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2000);
  }, 10000);

  it('shares one deadline between DNS lookup and the request', async () => {
    lookupMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([PUBLIC_ADDRESS]), 600);
        })
    );
    mockHttpsHang();

    const startedAt = Date.now();

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('DOWN');
    expect(response.body.error).toBe('Request timed out.');
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(1600);
  }, 10000);

  it('does not start the request when DNS consumes the whole deadline', async () => {
    lookupMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([PUBLIC_ADDRESS]), 1500);
        })
    );
    mockHttpsHang();

    const response = await request(app)
      .get('/health/check')
      .query({ url: TARGET });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('DOWN');
    expect(response.body.error).toBe('Request timed out.');
    expect(httpsRequestMock).not.toHaveBeenCalled();
  }, 10000);
});

describe('IP address security', () => {
  it('rejects IPv4 loopback addresses', () => {
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('127.255.255.254')).toBe(false);
  });

  it('rejects private IPv4 addresses', () => {
    expect(isPublicAddress('10.0.0.1')).toBe(false);
    expect(isPublicAddress('10.255.255.255')).toBe(false);
    expect(isPublicAddress('172.16.0.1')).toBe(false);
    expect(isPublicAddress('172.31.255.254')).toBe(false);
    expect(isPublicAddress('192.168.1.1')).toBe(false);
    expect(isPublicAddress('192.168.255.255')).toBe(false);
  });

  it('accepts addresses just outside the 172.16.0.0/12 range', () => {
    expect(isPublicAddress('172.15.255.255')).toBe(true);
    expect(isPublicAddress('172.32.0.1')).toBe(true);
  });

  it('rejects IPv4 link-local addresses', () => {
    expect(isPublicAddress('169.254.1.1')).toBe(false);
    expect(isPublicAddress('169.254.169.254')).toBe(false);
  });

  it('rejects unspecified and this-network IPv4 addresses', () => {
    expect(isPublicAddress('0.0.0.0')).toBe(false);
    expect(isPublicAddress('0.255.255.255')).toBe(false);
  });

  it('rejects IPv4 carrier-grade NAT addresses', () => {
    expect(isPublicAddress('100.64.0.1')).toBe(false);
    expect(isPublicAddress('100.127.255.255')).toBe(false);
  });

  it('accepts addresses just outside the carrier-grade NAT range', () => {
    expect(isPublicAddress('100.63.255.255')).toBe(true);
    expect(isPublicAddress('100.128.0.1')).toBe(true);
  });

  it('rejects IPv4 documentation addresses', () => {
    expect(isPublicAddress('192.0.2.1')).toBe(false);
    expect(isPublicAddress('198.51.100.1')).toBe(false);
    expect(isPublicAddress('203.0.113.1')).toBe(false);
  });

  it('rejects IPv4 protocol assignment and 6to4 relay addresses', () => {
    expect(isPublicAddress('192.0.0.1')).toBe(false);
    expect(isPublicAddress('192.0.0.8')).toBe(false);
    expect(isPublicAddress('192.88.99.1')).toBe(false);
  });

  it('rejects IPv4 benchmarking, multicast, reserved and broadcast addresses', () => {
    expect(isPublicAddress('198.18.0.1')).toBe(false);
    expect(isPublicAddress('198.19.255.255')).toBe(false);
    expect(isPublicAddress('224.0.0.1')).toBe(false);
    expect(isPublicAddress('239.255.255.255')).toBe(false);
    expect(isPublicAddress('240.0.0.1')).toBe(false);
    expect(isPublicAddress('255.255.255.255')).toBe(false);
  });

  it('accepts addresses just outside the benchmarking range', () => {
    expect(isPublicAddress('198.17.255.255')).toBe(true);
    expect(isPublicAddress('198.20.0.1')).toBe(true);
  });

  it('rejects IPv6 loopback and unspecified addresses', () => {
    expect(isPublicAddress('::1')).toBe(false);
    expect(isPublicAddress('::')).toBe(false);
  });

  it('rejects IPv4-compatible IPv6 addresses', () => {
    expect(isPublicAddress('::7f00:1')).toBe(false);
    expect(isPublicAddress('::a00:1')).toBe(false);
  });

  it('rejects IPv6 unique-local addresses', () => {
    expect(isPublicAddress('fc00::1')).toBe(false);
    expect(isPublicAddress('fd00::1')).toBe(false);
  });

  it('rejects IPv6 link-local addresses', () => {
    expect(isPublicAddress('fe80::1')).toBe(false);
  });

  it('rejects IPv6 multicast addresses', () => {
    expect(isPublicAddress('ff02::1')).toBe(false);
    expect(isPublicAddress('ff00::1')).toBe(false);
  });

  it('rejects IPv6 documentation and transition addresses', () => {
    expect(isPublicAddress('2001:db8::1')).toBe(false);
    expect(isPublicAddress('2002::1')).toBe(false);
    expect(isPublicAddress('2001::1')).toBe(false);
  });

  it('rejects IPv6 special-purpose ranges', () => {
    expect(isPublicAddress('64:ff9b:1::1')).toBe(false);
    expect(isPublicAddress('100::1')).toBe(false);
    expect(isPublicAddress('3fff::1')).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 loopback and private addresses', () => {
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:192.168.1.1')).toBe(false);
    expect(isPublicAddress('::ffff:169.254.169.254')).toBe(false);
  });

  it('accepts IPv4-mapped IPv6 public addresses', () => {
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('rejects invalid IP addresses', () => {
    expect(isPublicAddress('not-an-ip')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
    expect(isPublicAddress('999.999.999.999')).toBe(false);
  });

  it('accepts public IPv4 addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('93.184.216.34')).toBe(true);
  });

  it('accepts public IPv6 addresses', () => {
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicAddress('2001:4860:4860::8888')).toBe(true);
  });
});