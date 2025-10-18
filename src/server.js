const express = require( 'express' );
const { addClient, removeClient, setConfig } = require( './stream-manager' );

const app = express();

// Simple logging middleware for verbosity
app.use( ( req, res, next ) => {
  console.log( `[ ${new Date().toISOString()} ] ${ req.method } ${ req.originalUrl }` );
  next();
} );

app.get( '/', ( req, res ) => {
  res.send( `Hello World!` );
} );

const setupStreamRoute = async ( req, res, mjpegUrl ) => {
  // Set the response headers for an MJPEG stream
  res.writeHead( 200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary',
    'Cache-Control': 'no-cache',
    'Connection': 'close',
    'Pragma': 'no-cache'
  } );

  // Add the client's response stream to our list of clients
  await addClient( res, mjpegUrl );

  // When the client closes the connection, we need to clean up.
  req.on( 'close', () => {
    // The stream-manager will log the disconnection
    removeClient( res );
  } );
};

const start = ( config ) => {
  // Pass the config to the stream manager
  setConfig( config );

  app.get( '/stream', async ( req, res ) => {
    await setupStreamRoute( req, res, config.mjpegUrl );
  } );

  app.listen( config.port, () => {
    console.log( `Server listening on port ${ config.port }` );
    console.log( `Access the stream at http://${ config.host }:${ config.port }/stream` );
  } );
};

module.exports = { start };