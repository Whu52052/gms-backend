/**
 * Unit tests for lib/validate.js — S3 input validation library.
 * Run: node --test tests/unit/validate.test.js
 *
 * Covers:
 *   - Happy path (valid input passes)
 *   - Missing required fields
 *   - Type mismatches (string vs number vs boolean vs array vs object)
 *   - Length boundaries (min/max)
 *   - Regex match (e.g. username format)
 *   - Enum validation (role/system enum)
 *   - Nested array items validation
 *   - Coerce: string→number, string→boolean
 *   - Trim: default true trims strings
 *   - Malicious inputs:
 *     - Prototype pollution (__proto__/constructor/prototype stripped)
 *     - SQL injection attempts (treated as plain strings — should pass)
 *     - XSS payloads (treated as plain strings — should pass)
 *   - STRICT mode toggle (env VALIDATE_STRICT=false → warn-only)
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { validate, _sanitize } = require('../../lib/validate');

describe('validate — happy path', () => {
  test('valid input → ok=true, value matches', () => {
    const r = validate(
      { username: 'alice', password: 'pass1234' },
      { username: { type:'string', required:true, max:64 }, password: { type:'string', required:true, min:6 } }
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.username, 'alice');
    assert.strictEqual(r.value.password, 'pass1234');
    assert.strictEqual(r.errors.length, 0);
  });

  test('optional field omitted → ok=true, value not set', () => {
    const r = validate({ username: 'alice' }, { username: { type:'string', required:true }, age: { type:'number' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.username, 'alice');
    assert.strictEqual('age' in r.value, false);
  });

  test('default value applied when field missing', () => {
    const r = validate({}, { role: { type:'string', default:'user' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.role, 'user');
  });
});

describe('validate — required field', () => {
  test('missing required → ok=false, error mentions field', () => {
    const r = validate({}, { username: { type:'string', required:true } });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0].msg, /username/);
  });

  test('null value treated as missing for required', () => {
    const r = validate({ username: null }, { username: { type:'string', required:true } });
    assert.strictEqual(r.ok, false);
  });

  test('null value ok when not required', () => {
    const r = validate({ username: null }, { username: { type:'string' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual('username' in r.value, false);
  });
});

describe('validate — string constraints', () => {
  test('max length enforced', () => {
    const r = validate({ s: 'a'.repeat(11) }, { s: { type:'string', max:10 } });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0].msg, /10/);
  });

  test('min length enforced', () => {
    const r = validate({ s: 'ab' }, { s: { type:'string', min:6 } });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0].msg, /6/);
  });

  test('regex enforced — passes when match', () => {
    const r = validate({ u: 'alice_01' }, { u: { type:'string', regex:/^[a-z0-9_]+$/ } });
    assert.strictEqual(r.ok, true);
  });

  test('regex enforced — fails when mismatch', () => {
    const r = validate({ u: 'alice!!' }, { u: { type:'string', regex:/^[a-z0-9_]+$/, regexMsg:'bad' } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errors[0].msg, 'bad');
  });

  test('enum — passes when in list', () => {
    const r = validate({ role: 'admin' }, { role: { type:'string', enum:['user','admin'] } });
    assert.strictEqual(r.ok, true);
  });

  test('enum — fails when not in list', () => {
    const r = validate({ role: 'superadmin' }, { role: { type:'string', enum:['user','admin'] } });
    assert.strictEqual(r.ok, false);
    // Error message lists allowed values, not the rejected input
    assert.match(r.errors[0].msg, /user\/admin/);
  });
});

describe('validate — trim', () => {
  test('default trim=true trims strings', () => {
    const r = validate({ s: '  hello  ' }, { s: { type:'string' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.s, 'hello');
  });

  test('trim=false keeps whitespace', () => {
    const r = validate({ s: '  hello  ' }, { s: { type:'string', trim:false } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.s, '  hello  ');
  });
});

describe('validate — number', () => {
  test('rejects string when no coerce', () => {
    const r = validate({ n: '42' }, { n: { type:'number' } });
    assert.strictEqual(r.ok, false);
  });

  test('coerces numeric string → number', () => {
    const r = validate({ n: '42' }, { n: { type:'number', coerce:true } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.n, 42);
    assert.strictEqual(typeof r.value.n, 'number');
  });

  test('rejects non-numeric string even with coerce', () => {
    const r = validate({ n: 'abc' }, { n: { type:'number', coerce:true } });
    assert.strictEqual(r.ok, false);
  });

  test('min/max enforced', () => {
    assert.strictEqual(validate({ n: 5 }, { n: { type:'number', min:0, max:10 } }).ok, true);
    assert.strictEqual(validate({ n: -1 }, { n: { type:'number', min:0, max:10 } }).ok, false);
    assert.strictEqual(validate({ n: 11 }, { n: { type:'number', min:0, max:10 } }).ok, false);
  });

  test('int flag rejects decimal', () => {
    assert.strictEqual(validate({ n: 1.5 }, { n: { type:'number', int:true } }).ok, false);
    assert.strictEqual(validate({ n: 1 }, { n: { type:'number', int:true } }).ok, true);
  });

  test('NaN rejected', () => {
    const r = validate({ n: NaN }, { n: { type:'number' } });
    assert.strictEqual(r.ok, false);
  });
});

describe('validate — boolean', () => {
  test('accepts true/false', () => {
    assert.strictEqual(validate({ b: true }, { b: { type:'boolean' } }).ok, true);
    assert.strictEqual(validate({ b: false }, { b: { type:'boolean' } }).ok, true);
  });

  test('rejects string when no coerce', () => {
    assert.strictEqual(validate({ b: 'true' }, { b: { type:'boolean' } }).ok, false);
  });

  test('coerces "true"/"false" string → boolean', () => {
    assert.strictEqual(validate({ b: 'true' }, { b: { type:'boolean', coerce:true } }).value.b, true);
    assert.strictEqual(validate({ b: 'false' }, { b: { type:'boolean', coerce:true } }).value.b, false);
  });
});

describe('validate — array', () => {
  test('accepts array', () => {
    const r = validate({ tags: ['a','b'] }, { tags: { type:'array' } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.value.tags, ['a','b']);
  });

  test('rejects non-array', () => {
    const r = validate({ tags: 'a,b' }, { tags: { type:'array' } });
    assert.strictEqual(r.ok, false);
  });

  test('max items enforced', () => {
    const r = validate({ tags: ['a','b','c'] }, { tags: { type:'array', max:2 } });
    assert.strictEqual(r.ok, false);
  });

  test('items validated', () => {
    const r = validate({ tags: ['ok','bad!!'] }, { tags: { type:'array', items: { type:'string', regex:/^[a-z]+$/ } } });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0].msg, /tags\[1\]/);
  });
});

describe('validate — object', () => {
  test('accepts plain object', () => {
    const r = validate({ meta: { k: 1 } }, { meta: { type:'object' } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.value.meta, { k: 1 });
  });

  test('rejects array', () => {
    const r = validate({ meta: [1,2] }, { meta: { type:'object' } });
    assert.strictEqual(r.ok, false);
  });

  test('rejects null', () => {
    const r = validate({ meta: null }, { meta: { type:'object', required:true } });
    assert.strictEqual(r.ok, false);
  });

  test('nested schema validated', () => {
    const r = validate({ meta: { count: 'abc' } }, {
      meta: { type:'object', schema: { count: { type:'number', coerce:true } } }
    });
    assert.strictEqual(r.ok, false);
  });
});

describe('validate — malicious inputs (prototype pollution)', () => {
  test('strips __proto__ from input', () => {
    const input = JSON.parse('{"__proto__":{"polluted":"yes"},"name":"ok"}');
    const r = validate(input, { name: { type:'string' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.name, 'ok');
    // Verify Object.prototype was NOT polluted
    assert.strictEqual(({}).polluted, undefined);
  });

  test('strips constructor from input', () => {
    const input = JSON.parse('{"constructor":{"prototype":{"polluted":1}}}');
    const r = validate(input, { name: { type:'string' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(({}).polluted, undefined);
  });

  test('strips prototype from input', () => {
    const input = JSON.parse('{"prototype":{"x":1},"name":"ok"}');
    const r = validate(input, { name: { type:'string' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.name, 'ok');
  });

  test('_sanitize recurses into nested objects', () => {
    const input = JSON.parse('{"a":{"__proto__":{"x":1},"b":2}}');
    const out = _sanitize(input);
    // Use Object.keys to check own-properties (the `in` operator would also match inherited __proto__ on every object)
    assert.strictEqual(Object.keys(out.a).includes('__proto__'), false);
    assert.strictEqual(out.a.b, 2);
  });

  test('_sanitize recurses into arrays', () => {
    const input = JSON.parse('[{"__proto__":{"x":1}},{"y":2}]');
    const out = _sanitize(input);
    assert.strictEqual(Object.keys(out[0]).includes('__proto__'), false);
    assert.strictEqual(out[1].y, 2);
  });
});

describe('validate — SQL/XSS treated as plain strings', () => {
  test("SQL injection in string is preserved as plain text (no DB exec)", () => {
    const r = validate({ q: "' OR 1=1 --" }, { q: { type:'string', max:100 } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.q, "' OR 1=1 --");
  });

  test('XSS payload in string is preserved as plain text (no DOM exec at validation layer)', () => {
    const r = validate({ q: '<script>alert(1)</script>' }, { q: { type:'string', max:100 } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.q, '<script>alert(1)</script>');
  });
});

describe('validate — non-object input', () => {
  test('null input → ok=false', () => {
    const r = validate(null, {});
    assert.strictEqual(r.ok, false);
  });

  test('array input → ok=false (root must be object)', () => {
    const r = validate([1,2,3], {});
    assert.strictEqual(r.ok, false);
  });

  test('string input → ok=false', () => {
    const r = validate('hello', {});
    assert.strictEqual(r.ok, false);
  });
});

describe('validate — STRICT mode', () => {
  const oldStrict = process.env.VALIDATE_STRICT;
  afterEach(() => {
    if (oldStrict === undefined) delete process.env.VALIDATE_STRICT;
    else process.env.VALIDATE_STRICT = oldStrict;
    // Re-require to pick up env change; clear cache
    delete require.cache[require.resolve('../../lib/validate')];
  });

  test('STRICT=false → returns ok=true despite errors', () => {
    process.env.VALIDATE_STRICT = 'false';
    delete require.cache[require.resolve('../../lib/validate')];
    const { validate: validateNonStrict } = require('../../lib/validate');
    const r = validateNonStrict({}, { username: { type:'string', required:true } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.errors.length > 0, true);
  });
});

describe('validate — combined schemas (realistic)', () => {
  test('login schema — valid', () => {
    const schema = {
      username: { type:'string', required:true, max:64, regex:/^[^\s]{1,64}$/ },
      password: { type:'string', required:true, max:128 },
      machineCode: { type:'string', max:64 },
    };
    const r = validate({ username: 'alice', password: 'pass123', machineCode: 'we-045' }, schema);
    assert.strictEqual(r.ok, true);
  });

  test('login schema — username with space rejected', () => {
    const schema = {
      username: { type:'string', required:true, max:64, regex:/^[^\s]{1,64}$/, regexMsg:'用户名不能含空白' },
    };
    const r = validate({ username: 'alice 02' }, schema);
    assert.strictEqual(r.ok, false);
  });

  test('add user schema — role enum blocks superadmin', () => {
    const schema = {
      username: { type:'string', required:true, max:64 },
      password: { type:'string', required:true, min:6, max:128 },
      role:     { type:'string', enum:['user','admin'] },
    };
    const r = validate({ username: 'bob', password: 'pwd123', role: 'superadmin' }, schema);
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0].msg, /user\/admin/);
  });

  test('SN status change schema — invalid status rejected', () => {
    const schema = {
      snCode:    { type:'string', required:true, max:128, regex:/^[A-Za-z0-9_-]+$/ },
      newStatus: { type:'string', required:true, enum:['available','in_use','damaged','in_repair'] },
    };
    const r = validate({ snCode: 'WG1JA123', newStatus: 'hacked' }, schema);
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0].msg, /available\/in_use/);
  });

  test('password reset schema — too short rejected', () => {
    const schema = { newPassword: { type:'string', required:true, min:6, max:128 } };
    const r = validate({ newPassword: 'abc' }, schema);
    assert.strictEqual(r.ok, false);
  });
});
