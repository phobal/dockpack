import { appendFileSync } from "node:fs";

globalThis.fetch = async (url) => {
  appendFileSync(process.env.DOWNLOAD_REQUEST_LOG, `${url}\n`);
  const filename = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
  if (process.env.DOWNLOAD_TEST_MODE === "missing") return new Response("Not Found", { status: 404 });
  if (filename.endsWith(".sha256")) throw new Error("Checksum files must not be requested");
  if (process.env.DOWNLOAD_TEST_MODE === "interrupted") {
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial")); controller.error(new Error("Connection interrupted")); },
    }));
  }
  return new Response(`archive:${filename}`);
};
