let server: Bun.Server<any> | undefined;
let count_retry = 0;
let count_pager = 0;

function start() {
  server = Bun.serve({
    routes: {
      "/api/status": new Response("OK"),

      "/api/slow/:ms": (req) => {
        const ms = Number(req.params.ms);
        return new Promise((res) =>
          setTimeout(() => res(new Response("OK")), ms),
        );
      },

      "/api/data": Response.json({ data: 1 }),

      "/api/retry/:index": (req) => {
        const index = Number(req.params.index);
        if (count_retry < index) {
          count_retry++;
          return new Response("", {
            status: 429,
            headers: { "Retry-After": "600" },
          });
        }
        count_retry = 0;
        return new Response("OK");
      },

      "/api/pager": () => {
        if (!count_pager) {
          count_pager++;
          return Response.json(["OK"], { headers: { next: "true" } });
        }
        count_pager = 0;
        return Response.json(["OK"]);
      },

      "/api/reset": () => {
        count_retry = 0;
        count_pager = 0;
        return new Response("OK");
      },

      "/api/*": Response.json({ message: "Not found" }, { status: 404 }),
    },

    fetch(_req) {
      return new Response("Not Found", { status: 404 });
    },
  });

  console.info(`Server running at ${server.url}`);
}

async function stop() {
  if (!server) return;
  await server.stop(true);
  return server.unref();
}

export default { start, stop };
