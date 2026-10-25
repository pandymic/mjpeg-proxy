const { escapeXml } = require( './util' );

// How often the status page reloads itself, in seconds.
const REFRESH_SECONDS = 5;

/**
 * Formats a duration in seconds as a short human-readable string.
 *
 * @param {number} seconds
 * @returns {string} For example "3d 4h 12m" or "45s".
 */
const formatUptime = ( seconds ) => {
  const parts = [];
  const days = Math.floor( seconds / 86400 );
  const hours = Math.floor( seconds % 86400 / 3600 );
  const minutes = Math.floor( seconds % 3600 / 60 );
  if ( 0 < days ) {
    parts.push( `${ days }d` );
  }
  if ( 0 < hours ) {
    parts.push( `${ hours }h` );
  }
  if ( 0 < minutes ) {
    parts.push( `${ minutes }m` );
  }
  return 0 < parts.length ? parts.join( ' ' ) : `${ seconds }s`;
};

/**
 * Renders the read-only HTML status page from the object served at /health.
 * The page is static HTML that refreshes itself; it contains no scripts.
 *
 * @param {object} status - The status snapshot.
 * @returns {string} The HTML document.
 */
const renderStatusPage = ( status ) => {
  const { stream, transformer } = status;

  const rows = [
    [ 'Uptime', formatUptime( status.uptime ) ],
    [ 'Source', stream.state ],
    [ 'Clients', 0 === stream.maxClients ? stream.clients : `${ stream.clients } of ${ stream.maxClients }` ],
    [ 'Frame rate', `${ stream.fps } fps` ],
    [ 'Last frame', null === stream.lastFrameAgeMs ? 'never' : `${ ( stream.lastFrameAgeMs / 1000 ).toFixed( 1 ) }s ago` ],
    [ 'Frames received', stream.framesReceived ],
    [ 'Frames dropped', stream.framesDropped ],
    [ 'Failed attempts', `${ stream.failedAttempts } of ${ stream.maxAttempts }` ],
    [ 'Transformer', transformer.state ],
    [ 'Transformer loaded', transformer.loadedAt ?? 'never' ],
    [ 'Transformer errors', transformer.errors ],
    [ 'Transformer load failures', transformer.loadFailures ]
  ];

  const tableRows = rows
    .map( ( [ label, value ] ) => `<tr><th>${ escapeXml( label ) }</th><td>${ escapeXml( value ) }</td></tr>` )
    .join( '\n      ' );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="${ REFRESH_SECONDS }">
  <title>MJPEG Proxy Status</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 32rem; margin: 2rem auto; padding: 0 1rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #8884; text-align: left; }
    th { font-weight: 500; opacity: 0.75; }
    td { font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <h1>MJPEG Proxy</h1>
  <table>
      ${ tableRows }
  </table>
  <p><a href="stream">View stream</a> &middot; <a href="health">JSON</a></p>
</body>
</html>
`;
};

module.exports = { renderStatusPage };
