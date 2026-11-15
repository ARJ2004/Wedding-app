import { canonicalJson, requestHash } from './idempotency';

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it('hashes equal bodies equally regardless of key order', () => {
    expect(requestHash({ a: 1, b: 2 }).equals(requestHash({ b: 2, a: 1 }))).toBe(true);
    expect(requestHash({ a: 1 }).equals(requestHash({ a: 2 }))).toBe(false);
  });
});
