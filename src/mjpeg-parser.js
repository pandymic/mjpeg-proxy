const { Transform } = require( 'stream' );

/**
 * A Transform stream that parses an MJPEG stream and emits individual JPEG frames.
 * It buffers incoming data and looks for the JPEG Start-of-Image (SOI) and End-of-Image (EOI) markers.
 */
class MjpegParser extends Transform {
  constructor() {
    super( { objectMode: true } );
    this.buffer = Buffer.alloc(0);
    this.jpegStartMarker = Buffer.from( [ 0xFF, 0xD8 ] );
    this.jpegEndMarker = Buffer.from( [ 0xFF, 0xD9 ] );
  }

  _transform( chunk, encoding, callback ) {
    this.buffer = Buffer.concat( [ this.buffer, chunk ] );
    let soi = this.buffer.indexOf( this.jpegStartMarker );

    while ( -1 !== soi ) {

      const eoi = this.buffer.indexOf( this.jpegEndMarker, soi );

      if ( -1 !== eoi ) {

        const frame = this.buffer.subarray( soi, eoi + 2 ); // +2 to include the EOI marker
        this.push( frame );
        this.buffer = this.buffer.subarray( eoi + 2 );
        soi = this.buffer.indexOf( this.jpegStartMarker );

      } else {

        // We have a start marker but no end marker, so we need more data.
        // To prevent the buffer from growing indefinitely with corrupted data,
        // we'll discard the data before the SOI marker.
        this.buffer = this.buffer.subarray( soi );
        break;

      }
    }
    callback();
  }
}

module.exports = { MjpegParser };