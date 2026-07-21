import { describe, expect, it, vi } from 'vitest';
import { countryCodeForRequest, requestAddress } from './country.mjs';

const request = (forwarded, remoteAddress = '::ffff:127.0.0.1') => ({
  headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  socket: { remoteAddress },
});

describe('request country resolution', () => {
  it('uses the address appended by the Heroku router and retains only the country code', () => {
    const lookup = vi.fn(() => ({ country: 'za', city: 'Johannesburg', ll: [-26.2, 28.0] }));
    const incoming = request('198.51.100.4, 41.13.0.1');
    expect(requestAddress(incoming)).toBe('41.13.0.1');
    expect(countryCodeForRequest(incoming, lookup)).toBe('ZA');
    expect(lookup).toHaveBeenCalledWith('41.13.0.1');
  });

  it('handles mapped IPv4 addresses and returns unknown for invalid or failed lookups', () => {
    expect(requestAddress(request(undefined))).toBe('127.0.0.1');
    expect(countryCodeForRequest(request('not-an-ip'), () => undefined)).toBe('ZZ');
    expect(countryCodeForRequest(request('203.0.113.2'), () => { throw new Error('lookup failed'); })).toBe('ZZ');
  });
});
