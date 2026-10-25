const http = require( 'node:http' );
const streamManager = require( './stream-manager' );
const transformer = require( './transformer' );
const { renderStatusPage } = require( './status-page' );
const { log, logError } = require( './util' );

// Time allowed for a clean shutdown before the process exits anyway.
const SHUTDOWN_TIMEOUT_MS = 5000;

// Routes that are polled frequently and would flood the log.
const QUIET_PATHS = new Set( [ '/', '/health' ] );

const STATUS_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': 'default-src \'none\'; style-src \'unsafe-inline\'',
  'X-Content-Type-Options': 'nosniff'
};

const STREAM_HEADERS = {
  'Content-Type': streamManager.CONTENT_TYPE,
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Connection': 'close',
  'Pragma': 'no-cache'
};

/**
 * Collects the status snapshot served by / and /health. Only counters and
 * states are included: no URLs, addresses, paths or error messages.
 *
 * @returns {object}
 */
const getStatus = () => ( {
  status: 'ok',
  uptime: Math.floor( process.uptime() ),
  stream: streamManager.getStatus(),
  transformer: transformer.getStatus()
} );

/**
 * Sends a complete response with a plain text or prebuilt body.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} headers
 * @param {string} body
 */
const send = ( res, statusCode, headers, body ) => {
  res.writeHead( statusCode, { ...headers, 'Content-Length': Buffer.byteLength( body ) } );
  res.end( body );
};

/**
 * Attaches a client to the MJPEG stream, or rejects it with 503 when the
 * client limit has been reached.
 *
 * @param {import('node:http').ServerResponse} res
 */
const handleStream = ( res ) => {
  if ( !streamManager.hasCapacity() ) {
    send( res, 503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30' }, 'Too many viewers. Try again later.\n' );
    return;
  }

  res.writeHead( 200, STREAM_HEADERS );
  // Register the close handler first so a client that disconnects straight
  // away is still removed.
  res.on( 'close', () => streamManager.removeClient( res ) );
  streamManager.addClient( res );
};

/**
 * Routes a request. Only GET and HEAD are supported, and HEAD is answered
 * without a body for the status routes only.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
const handleRequest = ( req, res ) => {
  // Only the path matters; the base is a placeholder required by URL.
  const { pathname } = new URL( req.url, 'http://localhost' );

  if ( !QUIET_PATHS.has( pathname ) ) {
    log( `${ req.method } ${ pathname }` );
  }

  if ( 'GET' !== req.method && 'HEAD' !== req.method ) {
    send( res, 405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' }, 'Method not allowed.\n' );
    return;
  }

  switch ( pathname ) {
    case '/':
      send( res, 200, STATUS_PAGE_HEADERS, renderStatusPage( getStatus() ) );
      break;
    case '/health':
      send( res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify( getStatus() ) );
      break;
    case '/stream':
      if ( 'HEAD' === req.method ) {
        res.writeHead( 200, STREAM_HEADERS );
        res.end();
      } else {
        handleStream( res );
      }
      break;
    default:
      send( res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found.\n' );
  }
};

/**
 * Installs handlers for SIGTERM/SIGINT (graceful shutdown) and SIGHUP
 * (reload the frame transformer).
 *
 * @param {import('node:http').Server} server - The HTTP server to close.
 */
const installSignalHandlers = ( server ) => {
  const shutdown = ( signal ) => {
    log( `Received ${ signal }, shutting down.` );
    streamManager.shutdown();
    transformer.close();
    server.close( () => process.exit( 0 ) );
    server.closeAllConnections();
    setTimeout( () => process.exit( 1 ), SHUTDOWN_TIMEOUT_MS ).unref();
  };

  process.once( 'SIGTERM', shutdown );
  process.once( 'SIGINT', shutdown );
  process.on( 'SIGHUP', () => {
    log( 'Received SIGHUP, reloading frame transformer.' );
    transformer.reload();
  } );
};

/**
 * Starts the proxy server.
 *
 * @param {object} config - The validated application configuration.
 */
const start = ( config ) => {
  streamManager.setConfig( config );

  // The source URL may contain credentials, so it is not passed to drop-in code.
  const { mjpegUrl, ...transformerConfig } = config;
  transformer.init( { path: config.transformer, config: transformerConfig } );

  const server = http.createServer( handleRequest );

  server.on( 'error', ( err ) => {
    logError( `Server error: ${ err.message }` );
    process.exit( 1 );
  } );

  server.listen( config.port, config.host, () => {
    log( `Server listening on ${ config.host }:${ config.port }` );
    log( `Stream: http://${ config.host }:${ config.port }/stream` );
    log( `Status: http://${ config.host }:${ config.port }/` );
  } );

  installSignalHandlers( server );
};

module.exports = { start };
