import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
  entries: ["src/index", "src/admin"],
  declaration: true,
  clean: true,
  rollup: {
    emitCJS: false,
  },
});
