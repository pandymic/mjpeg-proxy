const fs = require( 'node:fs' );
const path = require( 'node:path' );
const sharp = require( 'sharp' );
const { log, logError } = require( './util' );

// A transform that has not settled within this time is abandoned and the
// original frame is used instead.
const TRANSFORM_TIMEOUT_MS = 5000;

// After this many failures in a row the transformer is bypassed until the file
// is changed or a reload is requested, instead of failing on every frame.
const MAX_CONSECUTIVE_ERRORS = 10;

// Editors often emit several change events per save; wait for them to settle.
const RELOAD_DEBOUNCE_MS = 250;

let filePath = null;
let context = Object.freeze( {} );
let activeModule = null;
let watcher = null;
let reloadTimer = null;

const stats = {
  // 'passthrough' (nothing loaded), 'active', or 'disabled' (too many errors).
  state: 'passthrough',
  loadedAt: null,
  loadFailures: 0,
  errors: 0,
  consecutiveErrors: 0
};

/**
 * Checks that a value is a Buffer that starts with a JPEG SOI marker.
 *
 * @param {*} value - The value returned by the transformer.
 * @returns {boolean}
 */
const isJpeg = ( value ) => Buffer.isBuffer( value ) && 4 <= value.length && 0xFF === value[ 0 ] && 0xD8 === value[ 1 ];

/**
 * Calls the optional dispose() hook of a transformer module so it can release
 * timers, handles or other resources before it is replaced.
 *
 * @param {object|null} mod - The module being unloaded.
 */
const disposeModule = ( mod ) => {
  if ( null === mod || 'function' !== typeof mod.dispose ) {
    return;
  }
  try {
    mod.dispose();
  } catch ( err ) {
    logError( `Frame transformer dispose() failed: ${ err.message }` );
  }
};

/**
 * Checks the transformer file before it is executed.
 *
 * @returns {string|null} Why the file must not be loaded, or null if it is fine.
 */
const checkFile = () => {
  let stat;
  try {
    stat = fs.statSync( filePath );
  } catch ( err ) {
    return err.message;
  }
  if ( !stat.isFile() ) {
    return 'not a regular file';
  }
  // The file is executed inside this process, so refuse anything that any
  // local user could have written to.
  if ( 0 !== ( stat.mode & 0o002 ) ) {
    return 'refusing to load a world-writable file';
  }
  return null;
};

/**
 * Requires the transformer module, bypassing the require cache.
 *
 * @returns {{ mod: object|null, error: string|null }} The module, or why it could not be used.
 */
const requireModule = () => {
  delete require.cache[ filePath ];
  try {
    const mod = require( filePath );
    if ( 'function' !== typeof mod?.transformFrame ) {
      return { mod: null, error: 'module does not export a transformFrame function' };
    }
    return { mod, error: null };
  } catch ( err ) {
    // The stack points at the offending line, which is what the author needs.
    return { mod: null, error: err.stack ?? String( err ) };
  }
};

/**
 * Loads or reloads the transformer module from disk.
 *
 * The new module only replaces the current one once it has been required
 * without throwing and has been confirmed to export transformFrame. On any
 * failure the previously loaded transformer, if there is one, stays in place.
 */
const load = () => {
  let error = checkFile();
  let mod = null;

  if ( null === error ) {
    ( { mod, error } = requireModule() );
  }

  if ( null !== error ) {
    // Do not leave a half-loaded or invalid module in the require cache.
    delete require.cache[ filePath ];
    stats.loadFailures++;
    logError( `Failed to load frame transformer from ${ filePath }: ${ error }` );
    logError( null !== activeModule ? 'Keeping the previously loaded transformer.' : 'Frames will pass through unmodified.' );
    return;
  }

  disposeModule( activeModule );
  activeModule = mod;
  stats.state = 'active';
  stats.loadedAt = new Date().toISOString();
  stats.consecutiveErrors = 0;
  log( `Loaded frame transformer from ${ filePath }` );
};

/**
 * Queues a reload, collapsing bursts of file system events into one load.
 */
const scheduleReload = () => {
  clearTimeout( reloadTimer );
  reloadTimer = setTimeout( load, RELOAD_DEBOUNCE_MS );
};

/**
 * Watches the directory containing the transformer rather than the file
 * itself. Editors that save by writing a temporary file and renaming it over
 * the original would otherwise leave the watcher attached to a deleted inode.
 */
const watch = () => {
  const dir = path.dirname( filePath );
  const base = path.basename( filePath );

  try {
    watcher = fs.watch( dir, ( eventType, filename ) => {
      // filename can be null on platforms that do not report it.
      if ( null !== filename && base !== filename ) {
        return;
      }
      scheduleReload();
    } );
    watcher.on( 'error', ( err ) => logError( `Frame transformer watcher error: ${ err.message }` ) );
  } catch ( err ) {
    logError( `Unable to watch ${ dir } for changes (${ err.message }). Send SIGHUP to reload manually.` );
  }
};

/**
 * Loads the transformer and starts watching it for changes.
 *
 * @param {object} options
 * @param {string} options.path - Path to the transformer module.
 * @param {object} options.config - Read-only settings exposed to the transformer.
 */
const init = ( { path: modulePath, config } ) => {
  filePath = path.resolve( modulePath );
  // sharp is passed in so transformers stored outside the project directory
  // can use it without having their own node_modules.
  context = Object.freeze( { sharp, config: Object.freeze( { ...config } ) } );
  load();
  watch();
};

/**
 * Runs the current transformer on a frame. Never rejects: on error, timeout
 * or invalid output the original frame is returned instead.
 *
 * @param {Buffer} frame - A JPEG frame from the source.
 * @returns {Promise<Buffer>} The transformed frame, or the original one.
 */
const run = async ( frame ) => {
  if ( 'active' !== stats.state ) {
    return frame;
  }

  const { transformFrame } = activeModule;
  let timer = null;

  try {

    const timeout = new Promise( ( resolve, reject ) => {
      timer = setTimeout( () => reject( new Error( `timed out after ${ TRANSFORM_TIMEOUT_MS } ms` ) ), TRANSFORM_TIMEOUT_MS );
    } );
    // Wrapping the call in a promise chain turns synchronous throws into rejections.
    const result = await Promise.race( [ Promise.resolve().then( () => transformFrame( frame, context ) ), timeout ] );

    if ( !isJpeg( result ) ) {
      throw new Error( 'transformFrame must return or resolve with a JPEG Buffer' );
    }
    stats.consecutiveErrors = 0;
    return result;

  } catch ( err ) {

    stats.errors++;
    stats.consecutiveErrors++;
    // Log the first error of a run rather than one line per frame.
    if ( 1 === stats.consecutiveErrors ) {
      logError( `Frame transformer error: ${ err.message }` );
    }
    if ( MAX_CONSECUTIVE_ERRORS <= stats.consecutiveErrors ) {
      stats.state = 'disabled';
      logError( `Frame transformer disabled after ${ MAX_CONSECUTIVE_ERRORS } consecutive errors. Frames will pass through until it is reloaded.` );
    }
    return frame;

  } finally {
    clearTimeout( timer );
  }
};

/**
 * Stops watching for changes and disposes of the loaded module.
 */
const close = () => {
  clearTimeout( reloadTimer );
  if ( null !== watcher ) {
    watcher.close();
    watcher = null;
  }
  disposeModule( activeModule );
  activeModule = null;
};

/**
 * Returns a snapshot of the transformer state for the status endpoints.
 * The file path is deliberately left out.
 *
 * @returns {object}
 */
const getStatus = () => ( {
  state: stats.state,
  loadedAt: stats.loadedAt,
  loadFailures: stats.loadFailures,
  errors: stats.errors
} );

module.exports = { init, run, reload: load, close, getStatus };
