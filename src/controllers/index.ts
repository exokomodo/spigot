import Dependencies from "../lib/dependencies";
import { Controller } from "../lib/rest/controller";

const IndexController: Controller<Dependencies> = {
  basePath: "/",
  routes: [
    {
      path: "/",
      method: "GET",
      handler: (req, res) => {
        console.log(req.deps);
        res.send("Hello World");
      },
    },
  ],
};

export default IndexController;
