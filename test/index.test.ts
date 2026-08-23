import server from "./server.ts";
server.start();

import "./functional/basic.ts";
import "./functional/handlers.ts";
import "./functional/overloads.ts";
import "./functional/parsing.ts";
import "./functional/signals.ts";
import "./functional/error.ts";

export { server };
