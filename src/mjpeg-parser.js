const { Transform } = require( 'node:stream' );

const SOI = Buffer.from( [ 0xFF, 0xD8 ] );
const EOI = Buffer.from( [ 0xFF, 0xD9 ] );
const EMPTY = Buffer.alloc( 0 );

// Upper bound on a single frame. Anything larger is treated as corrupt data
// and discarded so a misbehaving source cannot exhaust memory.
const DEFAULT_MAX_FRAME_SIZE = 16 * 1024 * 1024;

// How many bytes before a frame are searched for its part headers. Also the
// most that is kept while waiting for the next frame to start.
const MAX_HEADER_SIZE = 1024;

const CONTENT_LENGTH = /content-length:[ \t]*(\d+)/gi;

/**
 * Finds the last Content-Length header in a block of multipart headers.
 *
 * @param {Buffer} headers - The bytes preceding a frame.
 * @returns {number} The declared length, or 0 if there is none.
 */
const findContentLength = ( headers ) => {
  const matches = [ ...headers.toString( 'latin1' ).matchAll( CONTENT_LENGTH ) ];
  return 0 < matches.length ? Number( matches.at( -1 )[ 1 ] ) : 0;
};

/**
 * A Transform stream that parses an MJPEG byte stream and emits one Buffer per
 * JPEG frame.
 *
 * Each frame starts at a JPEG Start-of-Image marker (FFD8). When the part
 * headers declare a Content-Length and the frame ends with an End-of-Image
 * marker (FFD9) at exactly that length, that length is used. Otherwise the
 * frame ends at the first FFD9 after the start. Using the declared length
 * keeps frames intact when they embed a thumbnail, which has its own
 * FFD8/FFD9 pair.
 *
 * Emits a 'discard' event with the number of bytes dropped whenever an
 * oversized, unterminated frame is thrown away.
 */
class MjpegParser extends Transform {

  /**
   * @param {object} [options]
   * @param {number} [options.maxFrameSize] - Maximum frame size in bytes.
   */
  constructor( { maxFrameSize = DEFAULT_MAX_FRAME_SIZE } = {} ) {
    super( { readableObjectMode: true } );
    this.maxFrameSize = maxFrameSize;
    this.buffer = EMPTY;
    // True once this.buffer starts at the SOI of the frame being assembled.
    this.inFrame = false;
    // Content-Length declared for the current frame, or 0 if unknown.
    this.declaredLength = 0;
    // Offset into this.buffer where the next EOI search resumes. Avoids
    // rescanning bytes already checked when a frame spans many chunks.
    this.scanOffset = 0;
  }

  /**
   * Pushes the first `length` bytes of the buffer as a frame and resets the
   * per-frame state.
   *
   * @param {number} length - Frame length in bytes.
   */
  emitFrame( length ) {
    this.push( this.buffer.subarray( 0, length ) );
    this.buffer = this.buffer.subarray( length );
    this.inFrame = false;
    this.declaredLength = 0;
    this.scanOffset = 0;
  }

  /**
   * Appends the chunk to the pending buffer and pushes every complete frame.
   * Data that cannot be part of a frame is discarded as soon as possible so
   * the buffer only ever holds at most one partial frame plus its headers.
   */
  _transform( chunk, encoding, callback ) {
    this.buffer = 0 === this.buffer.length ? chunk : Buffer.concat( [ this.buffer, chunk ] );

    while ( 0 < this.buffer.length ) {

      if ( !this.inFrame ) {
        const soi = this.buffer.indexOf( SOI );

        if ( -1 === soi ) {
          // Keep the tail: it may hold the next part's headers, or the first
          // half of a marker split across chunks.
          this.buffer = this.buffer.subarray( -MAX_HEADER_SIZE );
          break;
        }

        const length = findContentLength( this.buffer.subarray( Math.max( 0, soi - MAX_HEADER_SIZE ), soi ) );
        this.declaredLength = this.maxFrameSize >= length ? length : 0;
        this.buffer = this.buffer.subarray( soi );
        this.inFrame = true;
        this.scanOffset = 0;
      }

      if ( 0 < this.declaredLength ) {
        if ( this.declaredLength > this.buffer.length ) {
          break;
        }
        const end = this.declaredLength;
        if ( EOI[ 0 ] === this.buffer[ end - 2 ] && EOI[ 1 ] === this.buffer[ end - 1 ] ) {
          this.emitFrame( end );
          continue;
        }
        // The declared length does not line up with an EOI marker, so the
        // header cannot be trusted. Fall back to scanning for the marker.
        this.declaredLength = 0;
      }

      const eoi = this.buffer.indexOf( EOI, Math.max( SOI.length, this.scanOffset ) );

      if ( -1 === eoi ) {
        if ( this.maxFrameSize < this.buffer.length ) {
          this.emit( 'discard', this.buffer.length );
          this.buffer = EMPTY;
          this.inFrame = false;
          this.scanOffset = 0;
        } else {
          // Back up one byte so an EOI split across chunks is still found.
          this.scanOffset = this.buffer.length - 1;
        }
        break;
      }

      this.emitFrame( eoi + EOI.length );

    }

    callback();
  }
}

module.exports = { MjpegParser, DEFAULT_MAX_FRAME_SIZE };
