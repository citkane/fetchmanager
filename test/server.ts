let server: Bun.Server<any> | undefined;
let count = 0;

function start() {
  server = Bun.serve({
    routes: {
      "/api/status": new Response("OK"),

      "/api/300ms": () =>
        new Promise((res) => setTimeout(() => res(new Response("OK")), 300)),

      "/api/data": Response.json({ data: 1 }),

      "/api/retry/:index": (i) => {
        const index = i.params.index;

        if (count < Number(index)) {
          count++;
          return new Response("", {
            status: 429,
            headers: { "Retry-After": "600" },
          });
        }
        return new Response("OK");
      },

      "/api/pager": () => {
        if (!count) {
          count++;
          return Response.json(["OK"], { headers: { next: "true" } });
        }
        return Response.json(["OK"]);
      },

      "/api/reset": () => {
        count = 0;
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
