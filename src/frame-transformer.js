const sharp = require( 'sharp' );

/**
 * Transforms a JPEG frame. This function is hot-reloadable.
 * You can edit this file and save it, and the running application will
 * automatically use the new logic without a restart.
 *
 * @param {Buffer} frameBuffer - The raw JPEG frame.
 * @param {object} config - The application configuration object.
 * @returns {Promise<Buffer>} A promise that resolves with the transformed frame buffer.
 */
const transformFrame = ( frameBuffer, config ) => {

  // Example: Rotate the image 180 degrees
  return sharp( frameBuffer ).rotate( 180 ).toBuffer()
    .catch( ( err ) => {
      console.error( `[ ${new Date().toISOString()} ] Error in transformFrame:`, err.message );
      return frameBuffer; // Return original frame on error
    } );

};

module.exports = { transformFrame };