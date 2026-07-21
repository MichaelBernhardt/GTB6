import { isIP } from 'node:net';
import geoip from 'geoip-country';

export const UNKNOWN_COUNTRY = 'ZZ';

function normalizeAddress(value) {
  let address = String(value ?? '').trim();
  if (address.startsWith('[')) address = address.slice(1, address.indexOf(']'));
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return isIP(address) ? address : undefined;
}

export function requestAddress(request) {
  const header = request.headers['x-forwarded-for'];
  const forwarded = Array.isArray(header) ? header.at(-1) : String(header ?? '').split(',').at(-1);
  return normalizeAddress(forwarded) ?? normalizeAddress(request.socket.remoteAddress);
}

export function countryCodeForRequest(request, lookup = geoip.lookup) {
  const address = requestAddress(request);
  if (!address) return UNKNOWN_COUNTRY;
  try {
    const country = lookup(address)?.country?.toUpperCase();
    return /^[A-Z]{2}$/.test(country ?? '') ? country : UNKNOWN_COUNTRY;
  } catch {
    return UNKNOWN_COUNTRY;
  }
}
