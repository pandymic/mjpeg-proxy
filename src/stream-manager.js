const http = require( 'http' );
const sharp = require( 'sharp' );
const fs = require( 'fs' );
const path = require( 'path' );
const { MjpegParser } = require( './mjpeg-parser' );

// This set will hold all the active client response streams.
const clients = new Set();

let mjpegUrl = '';
let streamRequest = null;
let retryTimeout = null;
let retryCount = 0;
let placeholderBuffer = null;
let config = {};

const transformerPath = path.resolve( __dirname, 'frame-transformer.js' );
let transformFrame; // This will hold our hot-reloadable function

/**
 * Sets the configuration for the stream manager.
 * @param {object} newConfig - The configuration object.
 */
const setConfig = ( newConfig ) => {
  config = newConfig;
};

/**
 * Loads or reloads the frame transformation logic from its file.
 */
const loadTransformer = () => {

  try {

    // Invalidate the require cache for our transformer file
    delete require.cache[ transformerPath ];
    // Re-require the module to get the latest version
    const transformerModule = require( transformerPath );
    if ( transformerModule && 'function' === typeof transformerModule.transformFrame ) {
      transformFrame = transformerModule.transformFrame;
      console.log( `[ ${new Date().toISOString()} ] Successfully loaded frame transformer.` );
    } else {
      throw new Error( 'transformFrame function not found in module.' );
    }

  } catch (e) {

    console.error( `[ ${new Date().toISOString()} ] Failed to load frame transformer:`, e );
    // As a fallback, use a simple pass-through function
    transformFrame = ( frameBuffer ) => Promise.resolve( frameBuffer );

  }
};

// Watch for changes in the transformer file and reload it.
fs.watch(transformerPath, () => loadTransformer());


/**
 * Generates a placeholder JPEG image with a status message.
 * @param {string} message - The text to display on the image.
 * @returns {Promise<Buffer>} A promise that resolves with the JPEG buffer.
 */
const createPlaceholderFrame = ( { title, url, status } ) => {
  const svgImage = `
    <svg width="640" height="480" viewBox="0 0 640 480" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="640" height="480" fill="#333" />
      <text x="50%" y="50%" font-family="sans-serif" fill="#fff" text-anchor="middle" dominant-baseline="central">
        <tspan x="50%" dy="-1.5em" font-size="40">${ title }</tspan>
        ${ url ? `<tspan x="50%" dy="1.8em" font-size="20" fill="#ccc">${ url }</tspan>` : '' }
        ${ status ? `<tspan x="50%" dy="1.5em" font-size="20">${ status }</tspan>` : '' }
      </text>
    </svg>
  `;
  return sharp( Buffer.from( svgImage ) ).jpeg( { quality: 80 } ).toBuffer();
};

/**
 * Updates the placeholder and broadcasts it to all clients.
 */
const updateAndBroadcastPlaceholder = async ( placeholderOptions ) => {
  placeholderBuffer = await createPlaceholderFrame( placeholderOptions );
  broadcastFrame(placeholderBuffer);
};

/**
 * Takes a processed frame, wraps it in the MJPEG boundary, and broadcasts it to all clients.
 * @param {Buffer} frameBuffer - The JPEG frame to broadcast.
 * @param {import('express').Response} [singleClient=null] - If provided, sends the frame only to this client.
 */
const broadcastFrame = ( frameBuffer, singleClient = null ) => {
  const boundary = '--myboundary';
  const headers = `\r\n${ boundary }\r\nContent-Type: image/jpeg\r\nContent-Length: ${ frameBuffer.length }\r\n\r\n`;
  const framePacket = Buffer.concat( [ Buffer.from( headers ), frameBuffer ] );

  if ( null !== singleClient ) {
    if ( singleClient.writable ) {
      singleClient.write( framePacket );
    }
  } else {
    for ( const client of clients ) {
      if ( client.writable ) {
        client.write( framePacket );
      }
    }
  }
};

/**
 * Stops the connection to the MJPEG source stream and cleans up resources.
 */
const stopMjpegStream = () => {
  if ( null !== retryTimeout ) {
    clearTimeout( retryTimeout );
    retryTimeout = null;
  }
  if ( null !== streamRequest ) {
    console.log( `[ ${new Date().toISOString()} ] Disconnecting from MJPEG source.` );
    streamRequest.destroy();
    streamRequest = null;
  }
  retryCount = 0;
};

/**
 * Handles a failed connection attempt or a disconnected stream by scheduling a retry.
 * @param {string} reason - The reason for the failure.
 */
const handleConnectionFailure = ( reason ) => {
  console.error( `[ ${new Date().toISOString()} ] Connection to ${ mjpegUrl } failed or closed: ${ reason }` );
  retryCount++;

  if ( 0 < clients.size && config.maxRetries > retryCount ) {
    updateAndBroadcastPlaceholder( { title: 'Connection Failed', url: mjpegUrl, status: `Retrying... (Attempt ${ retryCount + 1 }/${ config.maxRetries })` } );
    retryTimeout = setTimeout( connectToStream, config.retryInterval );
  } else if ( 0 < clients.size ) {
    console.error( `[ ${new Date().toISOString()} ] Max retries reached. Giving up.` );
    stopMjpegStream();
    updateAndBroadcastPlaceholder('Stream Unavailable. Max retries reached.');
  }
};

/**
 * Attempts to connect to the MJPEG source stream. Implements retry logic.
 */
const connectToStream = () => {
  updateAndBroadcastPlaceholder( { title: 'Connecting to stream...', url: mjpegUrl, status: `Attempt ${ retryCount + 1 } of ${ config.maxRetries }` } );
  console.log( `[ ${new Date().toISOString()} ] Attempting to connect to MJPEG stream at ${ mjpegUrl }... (Attempt ${ retryCount + 1 }/${ config.maxRetries })` );

  const mjpegParser = new MjpegParser();

  mjpegParser.on( 'data', async ( frame ) => {
    // If we receive data, the connection is good. Reset retry counter.
    if ( 0 < retryCount ) {
      console.log( `[ ${new Date().toISOString()} ] Re-established connection to MJPEG stream.` );
      retryCount = 0;
    }
    const transformedFrame = await transformFrame( frame, config );
    broadcastFrame( transformedFrame );
  } );

  streamRequest = http.get( mjpegUrl, ( res ) => {
    console.log( `[ ${new Date().toISOString()} ] Connected to MJPEG stream at ${ mjpegUrl }` );
    retryCount = 0; // Reset on successful connection
    res.pipe( mjpegParser );

    res.on( 'close', () => {
      console.log( `[ ${new Date().toISOString()} ] MJPEG source stream closed.` );
      handleConnectionFailure( 'Source stream closed unexpectedly.' );
    } );
  } );

  streamRequest.on( 'error', ( e ) => {
    // This handles initial connection errors (e.g., DNS lookup failure, ECONNREFUSED)
    handleConnectionFailure( e.message );
  } );
};

/**
 * Adds a new client to the broadcast list.
 * Starts the source stream if this is the first client.
 * @param {import('express').Response} res - The client's response stream.
 */
const addClient = async ( res, url ) => {
  if ( 0 === clients.size ) {
    loadTransformer(); // Load the transformer on first client connection
    mjpegUrl = url;
    placeholderBuffer = await createPlaceholderFrame( { title: 'Initializing...' } );
    connectToStream();
  }
  clients.add( res );
  console.log( `[ ${new Date().toISOString()} ] Client connected. Total clients: ${ clients.size }` );
  if ( null !== placeholderBuffer ) {
    broadcastFrame( placeholderBuffer, res );
  }
};

/**
 * Removes a client from the broadcast list.
 * Stops the source stream if this was the last client.
 * @param {import('express').Response} res - The client's response stream.
 */
const removeClient = ( res ) => {
  clients.delete( res );
  console.log( `[ ${new Date().toISOString()} ] Client disconnected. Total clients: ${ clients.size }` );
  if ( 0 === clients.size ) {
    stopMjpegStream();
  }
};

module.exports = { addClient, removeClient, setConfig };