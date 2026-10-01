import { buildApp } from "../app.js";
import { config } from "../config/index.js";

const app = buildApp(config);

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`Server listening on port ${config.port} [env=${config.env}]`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
