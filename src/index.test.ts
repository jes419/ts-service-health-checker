
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './index';

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
});
