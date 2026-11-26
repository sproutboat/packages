import config from "../data/config.js";

export function sum(...values) {
  return values.reduce((total, value) => total + value, 0);
}
export const scale = (value) => value * config.factor;
export const PI2 = Math.PI * 2;
