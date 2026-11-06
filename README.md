# MJPEG Proxy Server

![Works on my machine](https://img.shields.io/badge/works%20on-my%20machine-blue)

Most cheap IP cameras struggle with more than one viewer. This proxy holds a single connection to the camera's MJPEG stream and serves it to as many clients as you like. It can also run each frame through a transform (rotate, crop, greyscale, and so on) that you can edit while the server is running.

## Features

- **Fan-out.** One upstream connection, any number of viewers.
- **Lazy connection.** Connects to the source when the first viewer arrives and disconnects when the last one leaves.
- **Retries.** Reconnects automatically after a dropped or stalled source, up to a configurable number of attempts.
- **Placeholders.** Viewers see a status image while the source is connecting or unavailable.
- **Hot-reloadable transforms.** Edit the transform file and the change applies to the live stream, without a restart.
- **Slow clients don't hold anything up.** A viewer that can't keep up gets frames dropped instead of building up a backlog in memory.
- **Optional viewer limit.** Cap concurrent viewers, or leave it unlimited.
- **Status page and health check.** Read-only, no authentication, no sensitive details.

## Requirements

- Node.js 22 or later
- [sharp](https://sharp.pixelplumbing.com/), the only dependency, which ships prebuilt binaries for most platforms

## Installation

```bash
git clone https://github.com/pandymic/mjpeg-proxy.git
cd mjpeg-proxy
npm install --omit=dev
```

## Usage

The source URL is required. Pass it as an argument or an environment variable.

```bash
node index.js --mjpegUrl="http://camera.local/stream" --port=9000
```

```bash
MJPEG_URL="http://camera.local/stream" LISTEN_PORT=9000 npm start
```

When running through npm, put `--` before the arguments: `npm start -- --mjpegUrl=...`.

`node index.js --help` lists every option.

## Configuration

Command-line arguments take precedence over environment variables.

| Argument        | Variable         | Description                                                    | Default                    |
| --------------- | ---------------- | -------------------------------------------------------------- | -------------------------- |
| `mjpegUrl`      | `MJPEG_URL`      | **Required.** Source stream URL, `http` or `https`.            |                            |
| `host`          | `LISTEN_HOST`    | Address to listen on.                                          | `127.0.0.1`                |
| `port`          | `LISTEN_PORT`    | Port to listen on.                                             | `48093`                    |
| `maxAttempts`   | `MAX_ATTEMPTS`   | Connection attempts before giving up.                          | `5`                        |
| `retryInterval` | `RETRY_INTERVAL` | Delay between attempts, in milliseconds.                       | `2500`                     |
| `timeout`       | `SOURCE_TIMEOUT` | Milliseconds without data before the source counts as stalled. | `10000`                    |
| `maxClients`    | `MAX_CLIENTS`    | Maximum concurrent viewers. `0` means unlimited.               | `0`                        |
| `transformer`   | `TRANSFORMER`    | Path to the frame transformer module.                          | `src/frame-transformer.js` |

The server listens on loopback only by default. Set `LISTEN_HOST=0.0.0.0` (or `::`) to accept connections from other machines. If you do, consider setting `MAX_CLIENTS`: each viewer holds an open connection for as long as it watches, and viewers beyond the limit get a `503` response.

Credentials in the source URL (`http://user:pass@camera/stream`) are sent to the camera using HTTP Basic auth. They are removed from log lines and placeholder images, along with any query string.

After the last retry fails, viewers keep seeing a "Stream Unavailable" placeholder. The next viewer to connect starts a new round of attempts.

## Endpoints

| Path      | Description                                                     |
| --------- | --------------------------------------------------------------- |
| `/stream` | The MJPEG stream (`multipart/x-mixed-replace`).                 |
| `/`       | Status page. Refreshes every 5 seconds.                         |
| `/health` | The same information as JSON, for monitoring.                   |

The status endpoints report only states and counters: source state, client count, frame rate, frame counts, retry count, and transformer state. They never include the source URL, addresses, file paths or error messages. Loading them does not connect to the source.

```json
{
  "status": "ok",
  "uptime": 3600,
  "stream": {
    "state": "streaming",
    "clients": 2,
    "maxClients": 0,
    "failedAttempts": 0,
    "maxAttempts": 5,
    "fps": 15,
    "lastFrameAgeMs": 40,
    "framesReceived": 54000,
    "framesDropped": 12
  },
  "transformer": {
    "state": "active",
    "loadedAt": "2026-01-01T00:00:00.000Z",
    "loadFailures": 0,
    "errors": 0
  }
}
```

`stream.state` is one of `idle` (no viewers), `connecting`, `streaming`, `retrying` or `failed`. `transformer.state` is `active`, `passthrough` (nothing loaded) or `disabled` (bypassed after repeated errors).

## Frame transforms

The transformer is a CommonJS module that exports `transformFrame( frame, context )`. It receives each JPEG frame as a Buffer and must return a JPEG Buffer, or a Promise that resolves to one. `context.sharp` is the [sharp](https://sharp.pixelplumbing.com/api-operation) module, and `context.config` is a read-only copy of the settings without the source URL.

The default file, `src/frame-transformer.js`, draws a welcome notice over the stream. It's there to show the proxy is working, and it explains how to remove itself. To pass frames through untouched, change the body of `transformFrame` to:

```javascript
return frame;
```

To rotate the image 180 degrees:

```javascript
return sharp( frame ).rotate( 180 ).toBuffer();
```

To make it greyscale:

```javascript
return sharp( frame ).greyscale().toBuffer();
```

Save the file and the running server picks up the change. You can also force a reload with `kill -HUP <pid>` or `systemctl reload mjpeg-proxy`.

To keep a local transform out of the git checkout, put it somewhere else and point `TRANSFORMER` at it. Use `context.sharp` there instead of `require( 'sharp' )`, since that path won't have its own `node_modules`.

### Safety

The loader guards against the usual ways a live edit can go wrong:

- A file that fails to load (syntax error, exception at load time, missing `transformFrame`) is rejected, and the previously loaded transform keeps running.
- If a transform throws, rejects, returns something that isn't a JPEG, or takes longer than 5 seconds, the original frame is sent instead.
- After 10 failures in a row, the transform is bypassed until the file is saved again or a reload is requested.
- Only one transform runs at a time. If frames arrive faster than they can be processed, the backlog is dropped and only the newest frame is kept, so latency stays low and frames stay in order.
- World-writable files are refused.
- If the module sets up timers or other resources at load time, export a `dispose()` function to release them. It is called before the module is replaced.

### Caveats

The loader limits the damage from mistakes, but it is not a sandbox:

- The transformer runs inside the server process with the server's privileges. It can read anything the server can read, open network connections, and so on. Only load code you trust.
- The 5-second timeout only catches asynchronous work. A synchronous infinite loop, or any long-running synchronous code, blocks the whole server: every viewer freezes and the status endpoints stop answering. Under systemd, the only way out is a restart. Running transforms in a worker thread would prevent this, but isn't done here.
- Every transform decodes and re-encodes the JPEG, so it costs CPU on every frame. The default welcome overlay takes about 10 ms per frame at 640x480 and about 45 ms at 1080p. If you don't need a transform, `return frame;` costs nothing.

## Running with systemd

`deploy/` contains a hardened unit file and an example environment file. The unit runs the service as a temporary unprivileged user (`DynamicUser`), with a read-only view of the file system, no capabilities and a restricted set of system calls.

```bash
sudo cp -r . /opt/mjpeg-proxy                 # or clone directly into /opt/mjpeg-proxy
cd /opt/mjpeg-proxy && sudo npm ci --omit=dev

sudo install -d -m 0755 /etc/mjpeg-proxy
sudo install -m 0600 deploy/mjpeg-proxy.env /etc/mjpeg-proxy/mjpeg-proxy.env
sudo install -m 0644 deploy/mjpeg-proxy.service /etc/systemd/system/mjpeg-proxy.service
sudoedit /etc/mjpeg-proxy/mjpeg-proxy.env    # set MJPEG_URL

sudo systemctl daemon-reload
sudo systemctl enable --now mjpeg-proxy
```

Useful commands:

```bash
systemctl status mjpeg-proxy
journalctl -u mjpeg-proxy -f
sudo systemctl reload mjpeg-proxy            # reload the frame transformer
curl -s http://127.0.0.1:48093/health
```

Notes:

- The unit expects Node at `/usr/bin/node` and the code at `/opt/mjpeg-proxy`. Edit `ExecStart` if yours differ.
- `ProtectHome=yes` hides `/home`, so a Node installed with nvm in a home directory won't be reachable. Install Node 22 system-wide (from your distribution or NodeSource), or point `ExecStart` at a copy outside `/home`.
- The project files must be readable by any user (the usual `0644`/`0755`), because the service user is created when the service starts.
- The environment file stays readable by root only. systemd reads it before dropping privileges, so credentials in `MJPEG_URL` aren't exposed to the service user.
- `systemd-analyze security mjpeg-proxy` shows how the hardening scores.

## Development

```bash
npm test
```

## License

ISC. See `LICENSE.md`.
