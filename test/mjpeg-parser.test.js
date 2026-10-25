const { test } = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const { MjpegParser } = require( '../src/mjpeg-parser' );

/**
 * Builds a minimal fake JPEG: SOI, a payload, EOI.
 */
const fakeJpeg = ( payload ) => Buffer.concat( [ Buffer.from( [ 0xFF, 0xD8 ] ), Buffer.from( payload ), Buffer.from( [ 0xFF, 0xD9 ] ) ] );

/**
 * Feeds chunks through a parser and collects the emitted frames.
 */
const parse = ( chunks, options ) => {
  const parser = new MjpegParser( options );
  const frames = [];
  parser.on( 'data', ( frame ) => frames.push( Buffer.from( frame ) ) );
  for ( const chunk of chunks ) {
    parser.write( chunk );
  }
  return { parser, frames };
};

test( 'extracts multiple frames from one chunk, skipping multipart headers', () => {
  const a = fakeJpeg( 'first' );
  const b = fakeJpeg( 'second' );
  const input = Buffer.concat( [ Buffer.from( '--b\r\nContent-Type: image/jpeg\r\n\r\n' ), a, Buffer.from( '\r\n--b\r\n\r\n' ), b ] );
  const { frames } = parse( [ input ] );
  assert.deepEqual( frames, [ a, b ] );
} );

test( 'handles markers split across chunks', () => {
  const frame = fakeJpeg( 'split-markers' );
  const chunks = [ frame.subarray( 0, 1 ), frame.subarray( 1, frame.length - 1 ), frame.subarray( frame.length - 1 ) ];
  const { frames } = parse( chunks );
  assert.deepEqual( frames, [ frame ] );
} );

test( 'handles a frame delivered one byte at a time', () => {
  const frame = fakeJpeg( 'byte-by-byte' );
  const { frames } = parse( [ ...frame ].map( ( byte ) => Buffer.from( [ byte ] ) ) );
  assert.deepEqual( frames, [ frame ] );
} );

test( 'does not buffer data that contains no frame start', () => {
  const { parser, frames } = parse( [ Buffer.alloc( 4096, 0x41 ), Buffer.alloc( 4096, 0x42 ) ] );
  assert.equal( frames.length, 0 );
  assert.ok( 1024 >= parser.buffer.length );
} );

test( 'discards an unterminated frame larger than maxFrameSize', () => {
  const discarded = [];
  const parser = new MjpegParser( { maxFrameSize: 1024 } );
  const frames = [];
  parser.on( 'data', ( frame ) => frames.push( frame ) );
  parser.on( 'discard', ( bytes ) => discarded.push( bytes ) );
  parser.write( Buffer.concat( [ Buffer.from( [ 0xFF, 0xD8 ] ), Buffer.alloc( 2048 ) ] ) );
  assert.equal( frames.length, 0 );
  assert.equal( discarded.length, 1 );
  assert.equal( parser.buffer.length, 0 );

  const next = fakeJpeg( 'recovered' );
  parser.write( next );
  assert.deepEqual( frames.map( ( frame ) => Buffer.from( frame ) ), [ next ] );
} );

/**
 * Builds a fake JPEG that embeds a thumbnail, so it contains an EOI marker
 * before its real end.
 */
const jpegWithThumbnail = () => fakeJpeg( Buffer.concat( [ Buffer.from( 'exif' ), fakeJpeg( 'thumb' ), Buffer.from( 'image-data' ) ] ) );

/**
 * Wraps a frame in multipart part headers.
 */
const part = ( frame, length = frame.length ) => Buffer.concat( [ Buffer.from( `--b\r\nContent-Type: image/jpeg\r\nContent-Length: ${ length }\r\n\r\n` ), frame, Buffer.from( '\r\n' ) ] );

test( 'uses Content-Length to keep frames with embedded thumbnails intact', () => {
  const frame = jpegWithThumbnail();
  const { frames } = parse( [ Buffer.concat( [ part( frame ), part( frame ) ] ) ] );
  assert.deepEqual( frames, [ frame, frame ] );
} );

test( 'uses Content-Length when headers and frame arrive in separate chunks', () => {
  const frame = jpegWithThumbnail();
  const input = part( frame );
  const split = input.indexOf( 0xFF );
  const chunks = [ input.subarray( 0, split - 3 ), input.subarray( split - 3, split + 4 ), input.subarray( split + 4 ) ];
  const { frames } = parse( chunks );
  assert.deepEqual( frames, [ frame ] );
} );

test( 'falls back to marker scanning when Content-Length is wrong', () => {
  const frame = fakeJpeg( 'mislabelled' );
  const { frames } = parse( [ part( frame, frame.length + 2 ), part( fakeJpeg( 'next' ) ) ] );
  assert.deepEqual( frames, [ frame, fakeJpeg( 'next' ) ] );
} );
