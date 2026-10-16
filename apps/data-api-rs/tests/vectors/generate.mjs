// Regenerates the V8 truth vectors in this directory that tests/vectors.rs
// checks the Rust emulation against. Node 24, from the repo root:
//   TZ=UTC node apps/data-api-rs/tests/vectors/generate.mjs apps/data-api-rs/tests/vectors
import fs from 'node:fs';
const out = process.argv[2];
const w = (name, v) => fs.writeFileSync(`${out}/${name}.json`, JSON.stringify(v, null, 1) + '\n');

// 1. Date.parse then toISOString (null when NaN or out of range)
const dateInputs = [
  '2026-09-14T04:11:55.123456+00:00', '2026-09-14T04:11:55+00:00', '2026-09-14T04:11:55.1+00:00',
  '2026-09-14T04:11:55.12+05:30', '2026-09-14T04:11:55.999999-08:00', '2026-09-14T04:11:55Z',
  '2026-09-14T04:11Z', '2026-09-14T04:11', '2026-09-14T04:11:55', '2026-09-14T04:11:55.5',
  '2026-09-14', '2026-09', '2026', '+002026-09-14T00:00:00Z', '-000001-01-01T00:00:00Z',
  '+275760-09-13T00:00:00Z', '+275760-09-13T00:00:00.001Z', '-271821-04-20T00:00:00Z', '-271821-04-19T23:59:59.999Z',
  '-000000-01-01T00:00:00Z', '2026-02-29T00:00Z', '2024-02-29T00:00Z', '2026-02-30T00:00Z', '2026-02-31T00:00Z',
  '2026-04-31T00:00Z', '2026-13-01T00:00Z', '2026-00-01T00:00Z', '2026-01-00T00:00Z', '2026-01-32T00:00Z',
  '2026-01-01T24:00Z', '2026-01-01T24:00:00Z', '2026-01-01T24:00:01Z', '2026-01-01T24:00:00.001Z',
  '2026-01-01T23:60Z', '2026-01-01T23:59:60Z', '2026-01-01T25:00Z', '2026-01-01T00:00:00.Z',
  '2026-01-01T00:00:00.1234567890Z', '2026-01-01t00:00:00z', '2026-01-01T00:00:00+0000',
  '2026-01-01T00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00', '2026-01-01T00:00:00 Z',
  '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+23:59', '2026-01-01T00:00:00+24:01', '2026-01-01T00:00:00-00:00',
  '0000-01-01T00:00Z', '9999-12-31T23:59:59.999999Z', '1970-01-01T00:00:00Z', '1969-12-31T23:59:59.999Z',
  '', ' ', 'abc', 'not a date', '2026-9-14', '2026-09-14T4:11Z', '20260914T041155Z', 'Mon, 14 Sep 2026 04:11:55 GMT',
  '2026/09/14', '09/14/2026', '2026-09-14T04:11:55.123456+00:00 ', ' 2026-09-14', '1', '12', '123', '12345',
  '2026-09-14T04', '2026-09-14T04:11:5Z', '2026-09-14T04:11:55.Z', 'T04:11Z', '2026-09-14Z', '2026-09-14+01:00',
  '2026-09-14T04:11:55+01:00:00', '2026-09-14T04:11:55.000+00:00', '2001-02-03T04:05:06.007Z', '2026-09-14T04:11:55.123456789+00:00',
  '2026-09-14T00:00:00.0005Z', '2026-09-14T00:00:00.9999Z', '1900-01-01T00:00:00Z', '0100-03-01T00:00:00Z',
];
w('dates', dateInputs.map((s) => {
  const t = Date.parse(s);
  let iso = null;
  if (!Number.isNaN(t)) { try { iso = new Date(t).toISOString(); } catch { iso = 'RangeError'; } }
  return { in: s, ms: Number.isNaN(t) ? null : t, iso };
}));

// 2. toISOString of ms values
const msInputs = [0, -1, 1, 1800000000000, 1800000000999, -62167219200000, -62167219200001, -62198755200000,
  253402300799999, 253402300800000, 8.64e15, -8.64e15, 1e15, -1e15, 951782400000, 4107542400000, -2208988800000];
w('iso', msInputs.map((ms) => ({ ms, iso: new Date(ms).toISOString() })));

// 3. JSON round trip
const jsonInputs = [
  '[0]', '[-0]', '[0.0]', '[-0.0]', '[1e21]', '[1e20]', '[123456789012345678901]', '[5e-7]', '[0.000001]', '[1.5e-7]',
  '[9007199254740993]', '[18446744073709551615]', '[18446744073709551616]', '[-9223372036854775809]', '[1.0]', '[1.50]', '[0.1]',
  '[100]', '[1e2]', '[1E+2]', '[2.5e-324]', '[5e-324]', '[1.7976931348623157e308]', '[123.456e7]', '[0.30000000000000004]',
  '[1180.5]', '[-1042.25]', '[3.14159265358979323846]', '[1e-7]', '[12345678.9]', '[1.2345678901234567e+21]',
  '{"b":1,"2":2,"1":3,"a":4}', '{"10":1,"9":2,"01":3,"-1":4,"4294967294":5,"4294967295":6,"1.5":7}',
  '{"a":1,"a":2,"b":3}', '{"b":1,"a":2,"b":3}', '{"__proto__":1,"x":2}', '{"\\u0000":1,"\\u001f":2,"\\u007f":3,"\\u2028":4}',
  '["a\\"b\\\\c/d\\b\\f\\n\\r\\t\\u0001\\u0010\\u00e9\\u20ac"]', '["\\ud800\\udf48"]', '[true,false,null,[],{}]',
  '{"0":"x","":1,"  ":2}', '{"9007199254740992":1,"3":2}',
];
w('json', jsonInputs.map((s) => ({ in: s, out: JSON.stringify(JSON.parse(s)) })));

// 4. Number(PORT) as loadConfig reads it
const portInputs = ['8080', ' 8080 ', '0x1F90', '0X1f90', '0b11', '0o17', '1e3', '8080.0', '8080.5', '+80', '-80', '0', '-0', '65535',
  '65536', '1', 'abc', '80abc', 'Infinity', '-Infinity', '+Infinity', 'NaN', '00080', '.5e1', '5.', '\t80\n', '\u00a080\u00a0',
  '\ufeff80', '\u200b80', '1_000', '0x', '0b', '0o8', '1e', '8080e0', '0.0008080e7', '\u300080', '\u2028 80'];
w('ports', portInputs.map((s) => {
  const trimmedEmpty = !s.trim();
  const port = trimmedEmpty ? 8080 : Number(s);
  return { in: s, ok: Number.isInteger(port) && port >= 1 && port <= 65535, port: Number.isNaN(port) ? 'NaN' : String(port) };
}));

// 5. request target -> pathname and search params, as new URL(target, 'http://localhost')
const targets = [
  '/', '/health', '/health/', '/health?x=1', '//x/health', '///health', '//', '/./health', '/v1/./players', '/v1/../health',
  '/v1/%2e/players', '/v1/%2E%2E/health', '/v1/players/..', '/v1/players/.', '/v1\\players', '\\health', '/documentations/',
  '/documentations//', 'http://h/health', 'HTTP://h/v1/players', 'https://h:8443/health', 'http://h', 'http:health',
  'http:/health', 'http:\\\\h\\health', 'ws://h/health', 'ftp://h/health', 'file:///health', 'file://h/health', 'file:health',
  'foo:bar', 'foo:/health', 'foo://h/health', '*', 'health', '?a=1', '#x', '/health#frag', '/health?a=1#f', '/v1/players/%61',
  '/v1/pl%61yers', '/a b', '/a"b', '/a<b>', '/a`b', '/a{b}', '/a|b', '/a^b', '/a%zz', '/%', '/%2F', '/a/%2e%2e/b',
  '/a/.%2e/b', '/a/%2e./b', '/a/..%2f/b', '//user:pw@h/health', '//h:99999/health', '//h:abc/health', '//h:/health',
  '//[::1]/health', '//[::1/health', '//h%20x/health', '//H.X/health', '//h_x/health', '//1.2.3.4/health', '//0x7f.1/health',
  '//256.1.1.1/health', '//1.2.3.4.5/health', '//xn--abc/health', '//a..b/health', '//@/health', '//h@/health',
  '/v1/matches?limit=1&limit=2', '/v1/matches?a+b=c+d', '/v1/matches?%41=%42', '/v1/matches?x=%zz', '/v1/matches?x=%E9',
  '/v1/matches?x=%C3%A9', '/v1/matches?=1', '/v1/matches?x', '/v1/matches?&&x=1&', '/v1/matches?x=1=2', '/v1/matches?x=a%2Bb',
  '/v1/matches?%ED%A0%80=1', '/v1/matches?\u00e9=1', '/v1/matches?x=%F0%90%8D%88', '/v1/matches?x=%F0%90%8D', '/\u00e9',
  'http://h/health?x#y', '/health?', '/health?#', 'HtTp://h/health', 'http://h:80/health', '/../../health', '/health/..',
  '/v1/players/aa%2fbb', '/v1//players', '/V1/players', '/a/b/c/../../health', '/.health', '/..health', '/%2e', '/%2e%2e',
  'http://h/./health', 'h/health', 'a:b:c', '1http://h/health', 'h+t.t-p://h/health', '//h/health\\x', '/a\tb', '/a\nb',
  'javascript:alert(1)', 'mailto:x@y', 'data:text/plain,x', 'blob:http://h/x',
];
w('targets', targets.map((t) => {
  try {
    const u = new URL(t, 'http://localhost');
    return { in: t, pathname: u.pathname, params: [...u.searchParams] };
  } catch (e) {
    return { in: t, error: e.name };
  }
}));

// 6. new URL(x) without base, as loadConfig validates SUPABASE_URL
const urls = ['http://kong:8000', 'https://x.example', 'http://kong:8000/', 'http://kong:8000///', 'ftp://x', 'kong:8000',
  'localhost:8000', '//kong', 'http://', 'http:///x', 'http://a b', 'HTTP://KONG', 'file:///x', 'mailto:x', 'not a url',
  'http://[::1]:54321', 'http://127.0.0.1:54321', 'http://h:65536', 'http://h:-1', 'http://u:p@h', 'ws://h', 'javascript:x',
  'http://h/path?q#f', 'http:h', 'https:/h', 'http://h%00', 'http://%41', 'http://h:0'];
w('base-urls', urls.map((s) => {
  try { const u = new URL(s); return { in: s, ok: true, protocol: u.protocol }; } catch (e) { return { in: s, ok: false, error: e.name }; }
}));

// 7. String(value) as player_seasons groups on it
const stringInputs = [null, true, false, 0, -0, 1.5, 1e21, 1e-7, 'x', '', [], [1, 2], [null, 'a', [3, [4]]], {}, { a: 1 }, [{}]];
w('strings', stringInputs.map((v) => ({ in: v, out: String(v) })));
