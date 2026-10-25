const http = require( 'node:http' );
const https = require( 'node:https' );
const sharp = require( 'sharp' );
const { MjpegParser } = require( './mjpeg-parser' );
const transformer = require( './transformer' );
const { log, logError, escapeXml, redactUrl } = require( './util' );

const BOUNDARY = 'mjpegboundary';
const CONTENT_TYPE = `multipart/x-mixed-replace; boundary=${ BOUNDARY }`;

// Number of recent frame timestamps used to estimate the frame rate.
const FPS_SAMPLES = 30;

// A source that has sent nothing for this long is not reported as streaming.
const STALE_FRAME_MS = 5000;

// All active client response streams.
const clients = new Set();

let config = {};
let sourceUrl = null;
let displayUrl = '';

// 'idle', 'connecting', 'streaming', 'retrying' or 'failed'.
let state = 'idle';

// Incremented on every connection attempt and on stop. Callbacks from an older
// attempt compare against it and do nothing if they are stale.
let connectionId = 0;
let streamRequest = null;
let retryTimeout = null;
let failedAttempts = 0;

let placeholderBuffer = null;
let placeholderSeq = 0;
let lastFrame = null;
let pendingFrame = null;
let transformBusy = false;

let framesReceived = 0;
let framesDropped = 0;
let frameTimes = [];

/**
 * Sets the configuration for the stream manager.
 *
 * @param {object} newConfig - The application configuration.
 */
const setConfig = ( newConfig ) => {
  config = newConfig;
  sourceUrl = new URL( config.mjpegUrl );
  displayUrl = redactUrl( sourceUrl );
};

/**
 * Renders a placeholder JPEG with a status message.
 *
 * @param {object} options
 * @param {string} options.title - Main line of text.
 * @param {string} [options.url] - Source URL to display. Must already be redacted.
 * @param {string} [options.status] - Secondary status line.
 * @returns {Promise<Buffer>} The JPEG buffer.
 */
const createPlaceholderFrame = ( { title, url, status } ) => {
  const svgImage = `
    <svg width="640" height="480" viewBox="0 0 640 480" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="640" height="480" fill="#333" />
      <text x="50%" y="50%" font-family="sans-serif" fill="#fff" text-anchor="middle" dominant-baseline="central">
        <tspan x="50%" dy="-1.5em" font-size="40">${ escapeXml( title ) }</tspan>
        ${ url ? `<tspan x="50%" dy="1.8em" font-size="20" fill="#ccc">${ escapeXml( url ) }</tspan>` : '' }
        ${ status ? `<tspan x="50%" dy="1.5em" font-size="20">${ escapeXml( status ) }</tspan>` : '' }
      </text>
    </svg>
  `;
  return sharp( Buffer.from( svgImage ) ).jpeg( { quality: 80 } ).toBuffer();
};

/**
 * Wraps a JPEG frame in a multipart part.
 *
 * @param {Buffer} frame - The JPEG frame.
 * @returns {Buffer} The boundary, part headers, frame and trailing CRLF.
 */
const buildPacket = ( frame ) => {
  const headers = `--${ BOUNDARY }\r\nContent-Type: image/jpeg\r\nContent-Length: ${ frame.length }\r\n\r\n`;
  return Buffer.concat( [ Buffer.from( headers ), frame, Buffer.from( '\r\n' ) ] );
};

/**
 * Writes a packet to one client. If the client has not yet drained the
 * previous frame the packet is skipped, so a slow viewer gets a lower frame
 * rate instead of an ever-growing write buffer.
 *
 * @param {import('node:http').ServerResponse} client - The client response.
 * @param {Buffer} packet - The packet from buildPacket().
 */
const writePacket = ( client, packet ) => {
  if ( client.writable && !client.writableNeedDrain ) {
    client.write( packet );
  }
};

/**
 * Sends a frame to every connected client.
 *
 * @param {Buffer} frame - The JPEG frame.
 */
const broadcastFrame = ( frame ) => {
  const packet = buildPacket( frame );
  for ( const client of clients ) {
    writePacket( client, packet );
  }
};

/**
 * Renders a new placeholder and shows it to clients if no live frames are
 * flowing. A render that finishes after a newer one was requested is dropped.
 *
 * @param {object} options - Passed to createPlaceholderFrame().
 */
const updatePlaceholder = ( options ) => {
  const seq = ++placeholderSeq;
  createPlaceholderFrame( options )
    .then( ( buffer ) => {
      if ( seq !== placeholderSeq ) {
        return;
      }
      placeholderBuffer = buffer;
      if ( null === lastFrame ) {
        broadcastFrame( buffer );
      }
    } )
    .catch( ( err ) => logError( `Failed to render placeholder: ${ err.message }` ) );
};

/**
 * Transforms a frame and broadcasts the result. Only one transform runs at a
 * time; frames that arrive in the meantime replace each other in a single
 * slot, so only the newest is processed next and output stays in order.
 *
 * @param {Buffer} frame - The source frame.
 * @param {number} id - The connection the frame came from.
 */
const processFrame = async ( frame, id ) => {
  transformBusy = true;
  const output = await transformer.run( frame );
  transformBusy = false;

  if ( id === connectionId ) {
    lastFrame = output;
    broadcastFrame( output );
  }

  if ( null !== pendingFrame ) {
    const next = pendingFrame;
    pendingFrame = null;
    processFrame( next, connectionId );
  }
};

/**
 * Handles a frame parsed from the source stream.
 *
 * @param {Buffer} frame - The source frame.
 * @param {number} id - The connection the frame came from.
 */
const onSourceFrame = ( frame, id ) => {
  if ( id !== connectionId ) {
    return;
  }

  framesReceived++;
  frameTimes.push( Date.now() );
  if ( FPS_SAMPLES < frameTimes.length ) {
    frameTimes.shift();
  }

  // Count a connection as healthy only once frames arrive, so a source that
  // accepts connections and then hangs up still runs out of retries.
  if ( 'streaming' !== state ) {
    if ( 0 < failedAttempts ) {
      log( 'Re-established connection to MJPEG source.' );
    }
    state = 'streaming';
    failedAttempts = 0;
  }

  if ( transformBusy ) {
    if ( null !== pendingFrame ) {
      framesDropped++;
    }
    pendingFrame = frame;
    return;
  }
  processFrame( frame, id );
};

/**
 * Stops the connection to the source and resets all connection state.
 */
const stopMjpegStream = () => {
  connectionId++;
  placeholderSeq++;
  if ( null !== retryTimeout ) {
    clearTimeout( retryTimeout );
    retryTimeout = null;
  }
  if ( null !== streamRequest ) {
    log( 'Disconnecting from MJPEG source.' );
    streamRequest.destroy();
    streamRequest = null;
  }
  state = 'idle';
  failedAttempts = 0;
  lastFrame = null;
  pendingFrame = null;
  placeholderBuffer = null;
  frameTimes = [];
};

/**
 * Handles a failed or dropped source connection by scheduling a retry, or by
 * giving up once the attempt limit is reached. After giving up, the next
 * client to connect starts a fresh round of attempts.
 *
 * @param {string} reason - Why the connection failed.
 */
const handleConnectionFailure = ( reason ) => {
  logError( `Connection to ${ displayUrl } failed or closed: ${ reason }` );

  if ( null !== streamRequest ) {
    streamRequest.destroy();
    streamRequest = null;
  }
  lastFrame = null;
  pendingFrame = null;
  frameTimes = [];
  failedAttempts++;

  if ( config.maxAttempts > failedAttempts ) {
    state = 'retrying';
    updatePlaceholder( { title: 'Connection Failed', url: displayUrl, status: `Retrying... (attempt ${ failedAttempts + 1 } of ${ config.maxAttempts })` } );
    retryTimeout = setTimeout( connectToStream, config.retryInterval );
  } else {
    state = 'failed';
    logError( 'All connection attempts failed. Giving up until a new client connects.' );
    updatePlaceholder( { title: 'Stream Unavailable', url: displayUrl, status: 'All connection attempts failed.' } );
  }
};

/**
 * Opens a connection to the source stream.
 */
const connectToStream = () => {
  const id = ++connectionId;
  retryTimeout = null;
  state = 'connecting';

  updatePlaceholder( { title: 'Connecting...', url: displayUrl, status: `Attempt ${ failedAttempts + 1 } of ${ config.maxAttempts }` } );
  log( `Connecting to MJPEG source at ${ displayUrl } (attempt ${ failedAttempts + 1 } of ${ config.maxAttempts })` );

  // A single failure can surface as several events (error, then close).
  // Only the first one for the current attempt is acted on.
  let failed = false;
  const fail = ( reason ) => {
    if ( failed || id !== connectionId ) {
      return;
    }
    failed = true;
    handleConnectionFailure( reason );
  };

  const parser = new MjpegParser();
  parser.on( 'data', ( frame ) => onSourceFrame( frame, id ) );
  parser.on( 'discard', ( bytes ) => logError( `Discarded ${ bytes } bytes of unterminated frame data from source.` ) );

  const transport = 'https:' === sourceUrl.protocol ? https : http;

  // The timeout applies to socket inactivity, so it covers both a slow
  // connect and a source that stops sending mid-stream.
  const request = transport.get( sourceUrl, { timeout: config.timeout }, ( res ) => {
    if ( 200 !== res.statusCode ) {
      res.resume();
      fail( `Unexpected HTTP status ${ res.statusCode }` );
      return;
    }
    log( `Connected to MJPEG source at ${ displayUrl }` );
    res.on( 'error', ( err ) => fail( err.message ) );
    res.on( 'close', () => fail( 'Source stream closed.' ) );
    res.pipe( parser );
  } );

  request.on( 'timeout', () => request.destroy( new Error( `No data from source for ${ config.timeout } ms` ) ) );
  request.on( 'error', ( err ) => fail( err.message ) );
  streamRequest = request;
};

/**
 * Adds a client to the broadcast list. The client immediately gets the most
 * recent frame, or the current placeholder. Connects to the source if it is
 * not already connected or retrying.
 *
 * @param {import('node:http').ServerResponse} res - The client response.
 */
const addClient = ( res ) => {
  clients.add( res );
  log( `Client connected. Total clients: ${ clients.size }` );

  const initialFrame = lastFrame ?? placeholderBuffer;
  if ( null !== initialFrame ) {
    writePacket( res, buildPacket( initialFrame ) );
  }

  if ( null === streamRequest && null === retryTimeout ) {
    failedAttempts = 0;
    connectToStream();
  }
};

/**
 * Reports whether another client may connect under the maxClients limit.
 *
 * @returns {boolean}
 */
const hasCapacity = () => 0 === config.maxClients || config.maxClients > clients.size;

/**
 * Removes a client from the broadcast list and disconnects from the source
 * when the last client leaves.
 *
 * @param {import('node:http').ServerResponse} res - The client response.
 */
const removeClient = ( res ) => {
  if ( !clients.delete( res ) ) {
    return;
  }
  log( `Client disconnected. Total clients: ${ clients.size }` );
  if ( 0 === clients.size ) {
    stopMjpegStream();
  }
};

/**
 * Ends every client response and disconnects from the source.
 */
const shutdown = () => {
  for ( const client of clients ) {
    client.end();
  }
  clients.clear();
  stopMjpegStream();
};

/**
 * Returns a snapshot of the stream state for the status endpoints. Contains
 * no URLs, addresses or error messages.
 *
 * @returns {object}
 */
const getStatus = () => {
  const now = Date.now();
  const newest = frameTimes.at( -1 ) ?? null;
  const fresh = null !== newest && STALE_FRAME_MS > now - newest;
  const span = fresh ? newest - frameTimes[ 0 ] : 0;

  return {
    state,
    clients: clients.size,
    maxClients: config.maxClients,
    failedAttempts,
    maxAttempts: config.maxAttempts,
    fps: 0 < span ? Math.round( ( frameTimes.length - 1 ) * 10000 / span ) / 10 : 0,
    lastFrameAgeMs: null === newest ? null : now - newest,
    framesReceived,
    framesDropped
  };
};

module.exports = { CONTENT_TYPE, addClient, hasCapacity, removeClient, setConfig, shutdown, getStatus };
