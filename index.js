const { start } = require( './src/server' );

const parseArgs = () => {
  return process.argv.slice( 2 ).reduce( ( acc, arg ) => {

    if ( !arg.startsWith( '--' ) ) {
      return acc;
    }

    const argWithoutDashes = arg.substring( 2 );
    const eqIndex = argWithoutDashes.indexOf( '=' );

    if ( -1 !== eqIndex ) {
      // Handles --key=value
      const key = argWithoutDashes.substring( 0, eqIndex );
      const value = argWithoutDashes.substring( eqIndex + 1 );
      acc[ key ] = value;
    } else {
      // Handles --key value or just --key
      const key = argWithoutDashes;
      const nextArg = process.argv[ process.argv.indexOf( arg ) + 1 ];
      // If next arg exists and is not a flag, it's the value
      acc[ key ] = ( nextArg && !nextArg.startsWith( '--' ) ) ? nextArg : true;
    }

    return acc;

  }, {} );
};

const main = () => {
  console.log( 'Initializing MJPEG Proxy Server...' );

  const args = parseArgs();

  const config = {
    host: args.host || process.env.HOST || 'localhost',
    port: parseInt( args.port || process.env.PORT, 10 ) || 48080,
    mjpegUrl: args.mjpegUrl || process.env.MJPEG_URL,
    maxRetries: parseInt( args.maxRetries || process.env.MAX_RETRIES, 10 ) || 5,
    retryInterval: parseInt( args.retryInterval || process.env.RETRY_INTERVAL, 10 ) || 2500
  };

  // The MJPEG URL is essential, so we must exit if it's not provided.
  if ( !config.mjpegUrl ) {

    console.error( 'Error: MJPEG stream URL is required.' );
    console.error( 'Please provide it via the --mjpegUrl=<url> argument or the MJPEG_URL environment variable.' );
    process.exit( 1 );

  }

  start( config );
};

main();
