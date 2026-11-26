export function describe() {
  const encoded = Buffer.from("free buffer").toString("base64");
  return `${encoded}|${process.env.MODE}|${typeof global.setTimeout}`;
}
