const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' };

/**
 * Writes a timestamped line to stdout.
 *
 * @param {...*} args - Values passed through to console.log.
 */
const log = ( ...args ) => console.log( `[ ${ new Date().toISOString() } ]`, ...args );

/**
 * Writes a timestamped line to stderr.
 *
 * @param {...*} args - Values passed through to console.error.
 */
const logError = ( ...args ) => console.error( `[ ${ new Date().toISOString() } ]`, ...args );

/**
 * Escapes a value for safe inclusion in XML/SVG or HTML markup.
 *
 * @param {*} value - The value to escape. Non-strings are stringified.
 * @returns {string} The escaped string.
 */
const escapeXml = ( value ) => String( value ).replace( /[&<>"']/g, ( char ) => XML_ESCAPES[ char ] );

/**
 * Returns a display-safe version of a URL with credentials, query string and
 * fragment removed, so it can be logged or drawn on a placeholder frame
 * without leaking secrets.
 *
 * @param {URL} url - The URL to redact.
 * @returns {string} The redacted URL.
 */
const redactUrl = ( url ) => `${ url.protocol }//${ url.host }${ url.pathname }`;

module.exports = { log, logError, escapeXml, redactUrl };
