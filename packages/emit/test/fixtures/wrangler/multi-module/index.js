import { greet } from "./lib/greet.js";
import schema from "./schema.sql";
import blob from "./blob.bin";
export default { fetch() { return new Response(greet() + schema + blob.byteLength); } };
