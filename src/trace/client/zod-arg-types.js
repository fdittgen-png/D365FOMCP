/**
 * Derive a tool's argument-policy table from its Zod `inputSchema` (TDD §8,
 * `trace-args.js`). Zod 4 (`_zod.def`) with a Zod 3 fallback (`_def.typeName`).
 * Server-side only (the hook receives the derived table as JSON).
 */
import { policyFor } from '../contract/arg-policies.js';

function def(t) {
  return t?._zod?.def ?? t?._def ?? null;
}

function typeOf(t) {
  const d = def(t);
  if (!d) return 'other';
  const kind = d.type ?? (typeof d.typeName === 'string' ? d.typeName.replace(/^Zod/, '').toLowerCase() : 'other');
  switch (kind) {
    case 'optional': case 'default': case 'nullable': case 'nullish': case 'readonly': case 'catch': case 'pipe': case 'effects':
      return typeOf(d.innerType ?? d.in ?? d.schema);
    case 'string': case 'enum': case 'literal': case 'nativeenum':
      return 'string';
    case 'number': case 'int': case 'bigint':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array': {
      const elSchema = d.element ?? d.type_ ?? d.valueType;
      const el = typeOf(elSchema);
      if (el === 'string') return 'string[]';
      const shape = shapeOf(elSchema);
      if (shape && shape !== elSchema && typeof shape === 'object' && 'name' in shape) return 'object[]';
      return 'other';
    }
    case 'union': {
      const opts = d.options ?? [];
      const types = new Set(opts.map(typeOf));
      return types.size === 1 ? [...types][0] : 'other';
    }
    default:
      return 'other';
  }
}

/** `inputSchema` may be a raw shape `{ name: zodType }` or a ZodObject. */
export function shapeOf(inputSchema) {
  if (!inputSchema) return {};
  if (inputSchema.shape && typeof inputSchema.shape === 'object') return inputSchema.shape;
  const d = def(inputSchema);
  if (d?.shape && typeof d.shape === 'object') return d.shape;
  return inputSchema;
}

/** `{ param: 'string'|'number'|'boolean'|'string[]'|'other' }` */
export function argTypes(inputSchema) {
  const out = {};
  for (const [name, t] of Object.entries(shapeOf(inputSchema))) out[name] = typeOf(t);
  return out;
}

/** `{ param: policy|null }` — null means "no policy: dropped and counted". */
export function argPolicies(inputSchema) {
  const out = {};
  for (const [name, type] of Object.entries(argTypes(inputSchema))) out[name] = policyFor(name, type);
  return out;
}
