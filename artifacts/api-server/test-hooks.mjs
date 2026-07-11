// Resolve hook for `node --test`: the sources use bundler-style extensionless
// imports (esbuild resolves them at build time); raw Node ESM needs the .ts
// suffix, so retry failed relative resolutions with ".ts" / "/index.ts".
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        for (const suffix of [".ts", "/index.ts"]) {
          try { return nextResolve(specifier + suffix, context); } catch { /* keep trying */ }
        }
      }
      throw err;
    }
  },
});
