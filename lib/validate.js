/**
 * Input Validation — 零依赖手写 schema 验证器（S3 批次）
 *
 * 设计原则：
 *   - 零依赖、零框架（与 router.js 一致）
 *   - 返回 { ok, value, errors }，errors 形如 [{field, msg}]
 *   - value 是清洗后的对象（默认 trim 字符串、coerce 数字、移除未知字段）
 *   - STRICT 模式：可通过 env VALIDATE_STRICT=false 退化为 warn-only（不阻断请求）
 *
 * Schema 格式：
 *   {
 *     username: { type:'string', required:true, max:64, regex:/^[a-zA-Z0-9_-]+$/ },
 *     password: { type:'string', required:true, min:6, max:128 },
 *     role:     { type:'string', enum:['admin','user','superadmin'] },
 *     age:      { type:'number', min:0, max:150, coerce:true },
 *     tags:     { type:'array', items:{ type:'string' }, max:10 },
 *     active:   { type:'boolean', coerce:true },
 *   }
 *
 * 支持的 type: 'string' | 'number' | 'boolean' | 'array' | 'object'
 * 支持的约束: required, min, max, regex, enum, items, coerce, trim(默认 true)
 *
 * 用法：
 *   const { validate } = require('./lib/validate');
 *   const r = validate(body, { username:{ type:'string', required:true } });
 *   if (!r.ok) return sendJSON(res, { error: r.errors[0].msg }, 400);
 *   // 用 r.value（已清洗）
 */

'use strict';

const STRICT = process.env.VALIDATE_STRICT !== 'false'; // 默认严格

const TYPE_NAMES = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  array: 'array',
  object: 'object',
};

/** 递归移除原型污染键 */
function _sanitize(obj) {
  if (Array.isArray(obj)) {
    return obj.map(_sanitize);
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = _sanitize(obj[k]);
    }
    return out;
  }
  return obj;
}

function _isInt(v) { return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v); }

function _err(field, msg) { return { field, msg }; }

/**
 * 验证单个字段值
 * @returns {{value:any, error:?{field,msg}}} value 已清洗/转换后的值
 */
function _validateField(name, raw, rule) {
  if (raw === undefined || raw === null) {
    if (rule.required) return { value: undefined, error: _err(name, `${name} 为必填`) };
    // 未提供且非必填 → 用 default 或 undefined
    return { value: rule.default !== undefined ? rule.default : undefined, error: null };
  }

  let v = raw;
  const wantType = rule.type || 'string';

  // coerce: 字符串 → number/boolean
  if (rule.coerce && typeof v === 'string') {
    if (wantType === 'number') {
      const n = Number(v);
      if (v !== '' && Number.isFinite(n)) v = n;
    } else if (wantType === 'boolean') {
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
    }
  }

  // string 处理
  if (wantType === 'string') {
    if (typeof v !== 'string') {
      // 容忍 number → string 转换（除非 coerce=false）
      if (typeof v === 'number' && rule.coerce !== false) v = String(v);
      else return { value: undefined, error: _err(name, `${name} 必须是字符串`) };
    }
    if (rule.trim !== false) v = v.trim();
    if (rule.max !== undefined && v.length > rule.max) return { value: undefined, error: _err(name, `${name} 长度不能超过 ${rule.max}`) };
    if (rule.min !== undefined && v.length < rule.min) return { value: undefined, error: _err(name, `${name} 长度不能少于 ${rule.min}`) };
    if (rule.regex && !rule.regex.test(v)) return { value: undefined, error: _err(name, rule.regexMsg || `${name} 格式不正确`) };
    if (rule.enum && !rule.enum.includes(v)) return { value: undefined, error: _err(name, `${name} 必须是 ${rule.enum.join('/')} 之一`) };
    return { value: v, error: null };
  }

  // number 处理
  if (wantType === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { value: undefined, error: _err(name, `${name} 必须是数字`) };
    }
    if (rule.min !== undefined && v < rule.min) return { value: undefined, error: _err(name, `${name} 不能小于 ${rule.min}`) };
    if (rule.max !== undefined && v > rule.max) return { value: undefined, error: _err(name, `${name} 不能大于 ${rule.max}`) };
    if (rule.int && !_isInt(v)) return { value: undefined, error: _err(name, `${name} 必须是整数`) };
    return { value: v, error: null };
  }

  // boolean 处理
  if (wantType === 'boolean') {
    if (typeof v !== 'boolean') return { value: undefined, error: _err(name, `${name} 必须是布尔值`) };
    return { value: v, error: null };
  }

  // array 处理
  if (wantType === 'array') {
    if (!Array.isArray(v)) return { value: undefined, error: _err(name, `${name} 必须是数组`) };
    if (rule.max !== undefined && v.length > rule.max) return { value: undefined, error: _err(name, `${name} 元素数不能超过 ${rule.max}`) };
    if (rule.min !== undefined && v.length < rule.min) return { value: undefined, error: _err(name, `${name} 元素数不能少于 ${rule.min}`) };
    if (rule.items) {
      const out = [];
      for (let i = 0; i < v.length; i++) {
        const r = _validateField(`${name}[${i}]`, v[i], rule.items);
        if (r.error) return { value: undefined, error: r.error };
        out.push(r.value);
      }
      return { value: out, error: null };
    }
    return { value: v, error: null };
  }

  // object 处理（仅类型检查；嵌套 schema 由调用方递归 validate）
  if (wantType === 'object') {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { value: undefined, error: _err(name, `${name} 必须是对象`) };
    }
    // 嵌套 schema 验证
    if (rule.schema) {
      const nested = validate(v, rule.schema);
      if (!nested.ok) return { value: undefined, error: nested.errors[0] };
      return { value: nested.value, error: null };
    }
    return { value: _sanitize(v), error: null };
  }

  return { value: v, error: _err(name, `${name} 类型 ${wantType} 未知`) };
}

/**
 * 验证对象是否符合 schema
 * @param {object} input - 待验证对象（如 req.body）
 * @param {object} schema - 字段名 → 规则
 * @param {object} opts - { allowUnknown?: boolean }
 * @returns {{ok:boolean, value:object, errors:Array}}
 */
function validate(input, schema = {}, opts = {}) {
  const allowUnknown = opts.allowUnknown !== false; // 默认容忍未知字段（向后兼容）
  const errors = [];
  const out = {};

  // 输入必须是对象
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, value: {}, errors: [_err('_root', '请求体必须是对象')] };
  }

  // 防原型污染：清洗输入
  const sanitizedInput = _sanitize(input);

  // 检查未知字段（默认仅警告，不阻断）
  if (!allowUnknown) {
    for (const k of Object.keys(sanitizedInput)) {
      if (!schema[k]) {
        errors.push(_err(k, `未知字段 ${k}`));
      }
    }
  }

  // 按字段验证
  for (const fieldName of Object.keys(schema)) {
    const rule = schema[fieldName];
    const raw = sanitizedInput[fieldName];
    const r = _validateField(fieldName, raw, rule);
    if (r.error) {
      errors.push(r.error);
    } else if (r.value !== undefined) {
      out[fieldName] = r.value;
    }
  }

  if (errors.length > 0) {
    if (STRICT) {
      return { ok: false, value: out, errors };
    }
    // warn-only 模式：打印警告但仍返回 ok=true
    console.warn('[Validate] non-strict mode, ignoring errors:', errors.map(e => `${e.field}: ${e.msg}`).join('; '));
    return { ok: true, value: out, errors };
  }

  return { ok: true, value: out, errors: [] };
}

module.exports = { validate, _sanitize };
