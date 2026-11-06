const path = require( 'node:path' );
const { parseArgs } = require( 'node:util' );
const { start } = require( './src/server' );

// Each option can be set with --name=value, --name value, or the environment
// variable listed here. Command-line arguments take precedence.
const OPTIONS = {
  mjpegUrl: { env: 'MJPEG_URL', description: 'Source MJPEG stream URL (required, http or https)' },
  host: { env: 'LISTEN_HOST', description: 'Address to listen on', default: '127.0.0.1' },
  port: { env: 'LISTEN_PORT', description: 'Port to listen on', default: '48093' },
  maxAttempts: { env: 'MAX_ATTEMPTS', description: 'Connection attempts before giving up', default: '5' },
  retryInterval: { env: 'RETRY_INTERVAL', description: 'Delay between attempts, in ms', default: '2500' },
  timeout: { env: 'SOURCE_TIMEOUT', description: 'Source inactivity timeout, in ms', default: '10000' },
  maxClients: { env: 'MAX_CLIENTS', description: 'Maximum concurrent stream viewers, 0 for unlimited', default: '0' },
  transformer: { env: 'TRANSFORMER', description: 'Path to the frame transformer module', default: path.join( __dirname, 'src', 'frame-transformer.js' ) }
};

/**
 * Prints usage information to stdout.
 */
const printHelp = () => {
  console.log( 'Usage: node index.js --mjpegUrl=<url> [options]\n\nOptions:' );
  for ( const [ name, { env, description, default: fallback } ] of Object.entries( OPTIONS ) ) {
    console.log( `  --${ name } (${ env })\n      ${ description }${ undefined !== fallback ? ` [default: ${ fallback }]` : '' }` );
  }
};

/**
 * Parses a string as an integer within the given range.
 *
 * @param {string} name - Option name, used in the error message.
 * @param {string} raw - The raw value.
 * @param {number} min - Smallest allowed value.
 * @param {number} max - Largest allowed value.
 * @returns {number}
 * @throws {Error} If the value is not an integer in range.
 */
const parseInteger = ( name, raw, min, max ) => {
  const value = Number( raw );
  if ( !Number.isInteger( value ) || min > value || max < value ) {
    throw new Error( `${ name } must be an integer from ${ min } to ${ max }, got "${ raw }".` );
  }
  return value;
};

/**
 * Checks that the source URL is a valid http or https URL. The value itself
 * is never echoed back since it may contain credentials.
 *
 * @param {string} raw - The raw value.
 * @returns {string} The URL, unchanged.
 * @throws {Error} If the URL is missing or invalid.
 */
const parseSourceUrl = ( raw ) => {
  if ( undefined === raw || '' === raw ) {
    throw new Error( 'MJPEG stream URL is required. Provide it with --mjpegUrl=<url> or the MJPEG_URL environment variable.' );
  }
  if ( !URL.canParse( raw ) ) {
    throw new Error( 'mjpegUrl is not a valid URL.' );
  }
  const { protocol } = new URL( raw );
  if ( 'http:' !== protocol && 'https:' !== protocol ) {
    throw new Error( 'mjpegUrl must use http or https.' );
  }
  return raw;
};

/**
 * Builds the configuration from command-line arguments, environment
 * variables and defaults, in that order of precedence.
 *
 * @returns {object|null} The validated configuration, or null if --help was given.
 * @throws {Error} On unknown options or invalid values.
 */
const loadConfig = () => {
  const parseOptions = { help: { type: 'boolean', short: 'h' } };
  for ( const name of Object.keys( OPTIONS ) ) {
    parseOptions[ name ] = { type: 'string' };
  }

  const { values } = parseArgs( { options: parseOptions, strict: true } );
  if ( values.help ) {
    return null;
  }

  // Empty environment variables are treated as unset.
  const raw = {};
  for ( const [ name, { env, default: fallback } ] of Object.entries( OPTIONS ) ) {
    raw[ name ] = values[ name ] ?? ( process.env[ env ] || fallback );
  }

  return {
    mjpegUrl: parseSourceUrl( raw.mjpegUrl ),
    host: raw.host,
    port: parseInteger( 'port', raw.port, 1, 65535 ),
    maxAttempts: parseInteger( 'maxAttempts', raw.maxAttempts, 1, 1000 ),
    retryInterval: parseInteger( 'retryInterval', raw.retryInterval, 100, 3600000 ),
    timeout: parseInteger( 'timeout', raw.timeout, 1000, 3600000 ),
    maxClients: parseInteger( 'maxClients', raw.maxClients, 0, 100000 ),
    transformer: path.resolve( raw.transformer )
  };
};

/**
 * Entry point. Exits with status 1 if the configuration is invalid.
 */
const main = () => {
  let config;

  try {
    config = loadConfig();
  } catch ( err ) {
    console.error( `Error: ${ err.message }` );
    console.error( 'Run with --help for usage.' );
    process.exit( 1 );
  }

  if ( null === config ) {
    printHelp();
    return;
  }

  console.log( 'Initializing MJPEG Proxy Server...' );
  start( config );
};

main();
