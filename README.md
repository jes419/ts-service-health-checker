# ts-service-health-checker

A Dockerized TypeScript microservice for HTTP health monitoring, response-time measurement, request timeouts, and hostname allowlist enforcement.

## Features

- HTTP health status endpoint
- Remote HTTP and HTTPS health checks
- Response status and duration reporting
- Configurable request timeout
- Hostname allowlist enforcement
- URL validation and unsupported protocol rejection
- Automated API tests using Vitest and Supertest
- TypeScript compilation with strict type checking
- Dependency vulnerability auditing with npm

## Tech Stack

- **Language:** TypeScript
- **Runtime:** Node.js 24
- **Framework:** Express.js
- **Testing:** Vitest and Supertest
- **Package Manager:** npm
- **Containerization:** Docker

## Requirements

- Node.js 24 or a compatible supported version
- npm
- Docker (optional, for containerized execution)

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/jes419/ts-service-health-checker.git
cd ts-service-health-checker
npm install
```

## Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port | `3000` |
| `REQUEST_TIMEOUT_MS` | Timeout for target health checks | `5000` |
| `ALLOWED_HEALTHCHECK_HOSTS` | Comma-separated list of permitted hostnames | Empty |

Example PowerShell configuration:

```powershell
$env:PORT="3000"
$env:REQUEST_TIMEOUT_MS="5000"
$env:ALLOWED_HEALTHCHECK_HOSTS="example.com"
```

Configure the allowlist before starting the service if you intend to use the remote health-check endpoint.

## Run Locally

Build the TypeScript project:

```bash
npm run build
```

Start the service:

```bash
npm start
```

The service listens on port `3000` by default.

## API Endpoints

### `GET /health`

Returns the current service health status.

Example response:

```json
{
  "status": "UP",
  "timestamp": "2026-10-10T10:56:27.221Z",
  "service": "ts-service-health-checker",
  "uptime": 42.4
}
```

### `GET /health/check?url=https://example.com`

Checks an allowed HTTP or HTTPS target and reports its status and response duration.

Example response:

```json
{
  "status": "UP",
  "target": "https://example.com",
  "httpStatus": 200,
  "durationMs": 198,
  "checkedAt": "2026-10-10T10:56:49.003Z"
}
```

Only hostnames configured in `ALLOWED_HEALTHCHECK_HOSTS` are accepted. Requests to hosts outside the allowlist are rejected.

## Testing

Run the automated test suite:

```bash
npm test
```

Run the TypeScript build and tests together:

```bash
npm run check
```

The current test suite covers:

- Health endpoint responses
- Missing target URLs
- Invalid target URLs
- Unsupported URL protocols
- Rejection of hostnames outside the allowlist

## Security

- Hostname allowlisting restricts which targets the health-check endpoint can request.
- Request timeouts limit how long target checks can run.
- Dependency vulnerabilities can be checked with `npm audit`.

The service is not yet fully production-ready. Hostname allowlisting alone does not completely prevent SSRF, including risks involving DNS rebinding and private IP resolution. Production deployment requires additional DNS/IP validation, network-level egress restrictions, and deployment security review.

## Project Status

This project demonstrates a TypeScript and Express health-monitoring API with automated tests and basic SSRF mitigation. Additional security hardening and production deployment validation remain necessary.

## License

Specify a license before redistributing this project.
