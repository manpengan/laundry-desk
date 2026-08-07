export function listenLanGateway(server, options) {
  return new Promise((resolve, reject) => {
    const onStartupError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onStartupError);
      server.on("error", options.onRuntimeError);
      resolve();
    };

    server.once("error", onStartupError);
    server.once("listening", onListening);
    server.listen(options.port, options.bindHost);
  });
}
