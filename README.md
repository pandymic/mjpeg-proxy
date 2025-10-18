# MJPEG Proxy Server 📹

![Works on my machine](https://img.shields.io/badge/works%20on-my%20machine-blue)

Tired of your camera stream buckling under the pressure of more than one viewer? Do you wish you could just... turn your video feed upside down on a whim? 

Well, have I got the Node.js project for you! This is a highly-efficient, single-source MJPEG proxy server designed to handle multiple clients while performing on-the-fly transformations.

## Features

*   **Efficient Fan-Out**: Connects to one MJPEG stream and broadcasts it to many clients. No more overwhelming your poor underpowered camera source.
*   **Lazy Connection**: Only connects to the source stream when the first client arrives, and disconnects when the last one leaves. Smart!
*   **Resilient Retries**: If the source stream drops, it will automatically try to reconnect with a configurable delay and number of attempts.
*   **Informative Placeholders**: Displays a helpful placeholder image to clients during connection attempts or failures.
*   **Hot-Reloadable Transformations**: Edit the frame transformation logic and watch it apply *instantly* without restarting the server. It's basically magic. 🧙‍♂️
*   **Flexible Configuration**: Configure via command-line arguments or environment variables.

## Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/pandymic/mjpeg-proxy.git
    ```
2.  Navigate into the project directory:
    ```bash
    cd mjpeg-proxy
    ```
3.  Install the dependencies:
    ```bash
    npm install
    ```

## Usage

Fire it up! The `mjpegUrl` is a required parameter. You can provide it as a command-line argument or an environment variable.

#### Using Command-Line Arguments

To pass arguments to an npm script, you must use `--` after `npm run start`.

```bash
npm run start -- --mjpegUrl=http://my-camera-ip/stream --port=9000
```

#### Using Environment Variables

```bash
export MJPEG_URL="http://my-camera-ip/stream"
export PORT="9000"
npm run start
```

## Configuration

The application can be configured using command-line arguments (e.g., `--port=8080`) or environment variables (e.g., `PORT=8080`). Command-line arguments take precedence.

| Argument / Variable | Description                                       | Default                            |
| ------------------- | ------------------------------------------------- | ---------------------------------- |
| `mjpegUrl`          | **(Required)** The URL of the source MJPEG stream.  | *None*                             |
| `host`              | The host address for the server to listen on.     | `localhost`                        |
| `port`              | The port for the server to listen on.             | `48080`                            |
| `maxRetries`        | Max number of reconnection attempts.              | `5`                                |
| `retryInterval`     | Time in milliseconds between retry attempts.      | `2500`                             |

## Hot-Reloading Magic ✨

This is where the real fun begins. You can modify the image processing logic in real-time.

1.  Open the file: `/src/frame-transformer.js`
2.  Make any changes you want to the `transformFrame` function using the Sharp API.

    For example, to make the stream greyscale instead of rotated:
    ```javascript
    // from:
    return sharp( frameBuffer ).rotate( 180 ).toBuffer()

    // to:
    return sharp( frameBuffer ).greyscale().toBuffer()
    ```
3.  Save the file.

The running server will automatically detect the change and apply the new transformation to the stream. No restarts, no downtime.

## License

This project is licensed under the ISC License. See the `LICENSE.md` file for details.

