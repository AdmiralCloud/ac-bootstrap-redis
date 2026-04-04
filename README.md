# ac-bootstrap-redis

Redis initialization module for AdmiralCloud (AC) applications. Connects multiple named Redis instances in parallel based on your app's configuration and attaches them to the `acapi` object.

[![Node.js CI](https://github.com/AdmiralCloud/ac-bootstrap-redis/actions/workflows/node.js.yml/badge.svg)](https://github.com/AdmiralCloud/ac-bootstrap-redis/actions/workflows/node.js.yml) [![CodeQL](https://github.com/AdmiralCloud/ac-bootstrap-redis/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/AdmiralCloud/ac-bootstrap-redis/actions/workflows/github-code-scanning/codeql)

## Installation

```bash
yarn add ac-bootstrap-redis
```

## Usage

```js
const initRedis = require('ac-bootstrap-redis')

await initRedis(acapi, options)
```

After initialization, Redis instances are available as `acapi.redis.<name>`.

## Configuration

The module reads from `acapi.config.redis`:

```js
acapi.config = {
  redis: {
    servers: [
      { server: 'local', host: 'localhost', port: 6379 }
    ],
    databases: [
      { name: 'main',  server: 'local', db: 0 },
      { name: 'cache', server: 'local', db: 1 }
    ]
  }
}
```

### Server options

| Field    | Description               |
|----------|---------------------------|
| `server` | Unique identifier         |
| `host`   | Redis host                |
| `port`   | Redis port                |
| `tls`    | TLS options (optional)    |

### Database options

| Field             | Description                                      |
|-------------------|--------------------------------------------------|
| `name`            | Instance name — becomes `acapi.redis.<name>`     |
| `server`          | References a server by its `server` field        |
| `db`              | Redis database index                             |
| `ignoreBootstrap` | Skip this database during initialization         |

### Global Redis options

Set these directly under `acapi.config.redis` to apply to all instances:

- `timeout`
- `connectTimeout`
- `enableAutoPipelining`

Override any option per-environment via `acapi.config.localRedis`.

## Options

| Option           | Default | Description                                      |
|------------------|---------|--------------------------------------------------|
| `bootstrapping`  | `true`  | If `true`, throws on error instead of exiting    |
| `flushInTestmode`| `false` | Flush each DB when `config.environment === 'test'`|

## Return value

Returns an array of log entries describing each connection (name, host/port, DB, TLS status).

## Retry strategy

Connections are retried with increasing delays (1s → 2s → 5s → 10s → 15s) on failure.

## License

MIT, Copyright AdmiralCloud AG
