const server = Bun.serve({
  routes: {
    "/api/status": new Response("OK"),

    "/api/300ms": () =>
      new Promise((res) => setTimeout(() => res(new Response("OK")), 300)),

    "/api/data": Response.json({ data: 1 }),

    "/api/retry": new Response("", {
      status: 429,
      headers: { "Retry-After": "600" },
    }),

    "/api/*": Response.json({ message: "Not found" }, { status: 404 }),
  },

  fetch(_req) {
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server running at ${server.url}`);
