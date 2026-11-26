/** Parsed JSON, and the guards that read it. The lint rules ask that input is decoded at the boundary, so every check lives here. */
export type Json = string | number | boolean | null | JsonObject | Json[];
export interface JsonObject {
  readonly [key: string]: Json | undefined;
}
export type Input = Json | undefined;

export function isRecord(value: Input): value is JsonObject {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

export function isArray(value: Input): value is Json[] {
  return Array.isArray(value);
}

export function isString(value: Input): value is string {
  return Object(value) !== value && value === String(value);
}

export function isBoolean(value: Input): value is boolean {
  return value === true || value === false;
}

export function isNumber(value: Input): value is number {
  return Object(value) !== value && value === Number(value) && Number.isFinite(value);
}

export function isCount(value: Input): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 1;
}

export function isStringArray(value: Input): value is string[] {
  return isArray(value) && value.every(isString);
}
