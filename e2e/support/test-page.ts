/**
 * A loopback web server for the dApp tests.
 *
 * The content script is registered for `http://*` / `https://*`, so the test
 * page has to be served over HTTP; a `data:` or `file:` URL would not match,
 * and there is no outbound network in this environment. 127.0.0.1 is enough:
 * the extension treats it like any other origin.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Aubergine e2e dApp</title></head>
  <body>
    <h1>e2e test dApp</h1>
    <pre id="out">idle</pre>
  </body>
</html>`;

export interface TestPageServer {
  readonly origin: string;
  close(): Promise<void>;
}

export async function startTestPageServer(): Promise<TestPageServer> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
