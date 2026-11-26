// src/index.ts
var src_default = {
  async fetch(request) {
    if (new URL(request.url).pathname === "/blocked") {
      try {
        await fetch("http://169.254.169.254/latest/meta-data/");
        return new Response(`should not have reached here
`, { status: 500 });
      } catch (error) {
        return new Response(`blocked: ${error instanceof Error ? error.message : error}
`, { status: 403 });
      }
    }
    const response = await fetch("https://example.com/");
    return new Response(`example.com answered with ${response.status}
`);
  }
};
export {
  src_default as default
};
