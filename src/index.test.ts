
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, isPublicAddress } from './index';

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
  });

  it('rejects URLs containing credentials', async () => {
    const response = await request(app)
      .get('/health/check')
      .query({ url: 'https://user:password@example.com' });

    expect(response.status).toBe(400);
    expect(response.body.status).toBe('ERROR');
  });

  it('rejects duplicate URL query parameters', async () => {
    const response = await request(app)
      .get('/health/check?url=https%3A%2F%2Fexample.com&url=https%3A%2F%2Fgoogle.com');

    expect(response.status).toBe(400);
    expect(response.body.status).toBe('ERROR');
  });
});

describe('IP address security', () => {
  it('rejects IPv4 loopback addresses', () => {
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('127.255.255.254')).toBe(false);
  });

  it('rejects private IPv4 addresses', () => {
    expect(isPublicAddress('10.0.0.1')).toBe(false);
    expect(isPublicAddress('172.16.0.1')).toBe(false);
    expect(isPublicAddress('172.31.255.254')).toBe(false);
    expect(isPublicAddress('192.168.1.1')).toBe(false);
  });

  it('rejects IPv4 link-local addresses', () => {
    expect(isPublicAddress('169.254.1.1')).toBe(false);
  });

  it('rejects unspecified IPv4 addresses', () => {
    expect(isPublicAddress('0.0.0.0')).toBe(false);
  });

  it('rejects IPv6 loopback and unspecified addresses', () => {
    expect(isPublicAddress('::1')).toBe(false);
    expect(isPublicAddress('::')).toBe(false);
  });

  it('rejects IPv6 unique-local addresses', () => {
    expect(isPublicAddress('fc00::1')).toBe(false);
    expect(isPublicAddress('fd00::1')).toBe(false);
  });

  it('rejects IPv6 link-local addresses', () => {
    expect(isPublicAddress('fe80::1')).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 loopback addresses', () => {
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
  });

  it('rejects invalid IP addresses', () => {
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });

  it('accepts a public IPv4 address', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
  });
});
