/**
 * Frame transformer. This file is reloaded automatically when it changes, so
 * edits take effect without restarting the server.
 *
 * Contract:
 * - Export a transformFrame( frame, context ) function that returns a JPEG
 *   Buffer, or a Promise that resolves to one.
 * - context.sharp is the sharp module and context.config is a read-only copy
 *   of the server settings (without the source URL).
 * - Errors, timeouts and non-JPEG results are caught by the loader, which
 *   sends the original frame instead. Ten failures in a row disable the
 *   transformer until the file is saved again or the server gets SIGHUP.
 * - Avoid side effects at the top level of the module (timers, sockets).
 *   If they are needed, export a dispose() function to clean them up; it is
 *   called before the module is replaced or the server stops.
 * - Code here runs in the server process. A synchronous infinite loop will
 *   block the server, and the code has the same privileges as the server.
 *
 * The default below draws a welcome notice over every frame, as a sign that
 * the proxy is working. To pass frames through untouched, replace the body
 * of transformFrame with `return frame;`. To rotate the image instead:
 *
 *   return sharp( frame ).rotate( 180 ).toBuffer();
 */

const WELCOME_LINES = [
  'MJPEG Proxy is up and running',
  'Thanks for installing! This notice is drawn by the default frame transformer.',
  'To change or remove it, edit src/frame-transformer.js',
  'or point the TRANSFORMER setting at your own file.'
];

// Rough average glyph width relative to font size, used to fit the longest line.
const GLYPH_WIDTH_RATIO = 0.55;

// Rasterized overlays keyed by frame size. Frame sizes rarely change, so this
// stays tiny, and rasterizing once avoids redrawing the SVG on every frame.
const overlayCache = new Map();

/**
 * Escapes text for inclusion in SVG markup.
 *
 * @param {string} text
 * @returns {string}
 */
const escapeXml = ( text ) => text.replace( /[&<>]/g, ( char ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;' } )[ char ] );

/**
 * Builds the welcome overlay: a translucent full-width panel with the notice
 * centred on it, sized to fit the frame.
 *
 * @param {number} width - Frame width in pixels.
 * @param {number} height - Frame height in pixels.
 * @returns {{ svg: Buffer, top: number }} The panel SVG and its vertical offset in the frame.
 */
const buildOverlay = ( width, height ) => {
  const longest = Math.max( ...WELCOME_LINES.map( ( line ) => line.length ) );
  const fontSize = Math.max( 8, Math.floor( Math.min( height / 20, 0.9 * width / ( longest * GLYPH_WIDTH_RATIO ) ) ) );
  const lineHeight = Math.round( fontSize * 1.5 );
  const panelHeight = Math.min( height, lineHeight * ( WELCOME_LINES.length + 1 ) );

  const lines = WELCOME_LINES.map( ( line, index ) => {
    // The first line is the heading.
    const weight = 0 === index ? 'bold' : 'normal';
    return `<text x="50%" y="${ lineHeight * ( index + 1 ) }" font-weight="${ weight }">${ escapeXml( line ) }</text>`;
  } );

  const svg = Buffer.from( `
    <svg width="${ width }" height="${ panelHeight }" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#000" fill-opacity="0.6" />
      <g font-family="sans-serif" font-size="${ fontSize }" fill="#fff" text-anchor="middle" dominant-baseline="middle">
        ${ lines.join( '\n' ) }
      </g>
    </svg>
  ` );

  return { svg, top: Math.round( ( height - panelHeight ) / 2 ) };
};

/**
 * Rasterizes the overlay for a frame size once, so each frame only needs a
 * composite.
 *
 * @param {import('sharp')} sharp
 * @param {number} width
 * @param {number} height
 * @returns {Promise<object>} A sharp composite option.
 */
const renderOverlay = async ( sharp, width, height ) => {
  const { svg, top } = buildOverlay( width, height );
  const { data, info } = await sharp( svg ).raw().toBuffer( { resolveWithObject: true } );
  return { input: data, raw: { width: info.width, height: info.height, channels: info.channels }, top, left: 0 };
};

/**
 * Draws the welcome notice over the frame.
 *
 * @param {Buffer} frame - A JPEG frame from the source.
 * @param {{ sharp: import('sharp'), config: object }} context
 * @returns {Promise<Buffer>} The frame with the overlay, as JPEG.
 */
const transformFrame = async ( frame, { sharp } ) => {
  const image = sharp( frame );
  const { width, height } = await image.metadata();
  const key = `${ width }x${ height }`;

  if ( !overlayCache.has( key ) ) {
    // Store the promise so concurrent first frames share a single render.
    overlayCache.set( key, renderOverlay( sharp, width, height ) );
  }

  return image.composite( [ await overlayCache.get( key ) ] ).jpeg( { quality: 85 } ).toBuffer();
};

module.exports = { transformFrame };
