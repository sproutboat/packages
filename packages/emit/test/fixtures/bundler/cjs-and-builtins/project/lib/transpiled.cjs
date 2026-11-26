"use strict";
// What tsc and Babel print for a CommonJS package whose source has `export default`: the marker, a named export and a default.
Object.defineProperty(exports, "__esModule", { value: true });
exports.named = void 0;
exports.default = function transpiledDefault() {
  return "the default property";
};
exports.named = "the named export";
