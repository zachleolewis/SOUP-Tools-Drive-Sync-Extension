// The Vite/Rollup plugin an extension's build uses (shipped in the public template, docs/plans/EXTENSIONS_PLAN.md 5.1 and E0-2/E0-3).
//
// An extension is ONE ES module with no bare imports: the browser cannot resolve `soup` or `react`, and an import map
// would need an inline script (the CSP forbids it). So these modules are replaced, at build time, by tiny virtual modules
// that read what SOUP put on `globalThis.__soup` before it loaded the extension:
//
//   import { Plugin } from "soup"        -> const { Plugin } = globalThis.__soup.soup
//   import { useState } from "react"     -> the React SOUP itself runs (one React, so hooks work)
//   import { jsx } from "react/jsx-runtime", import { createRoot } from "react-dom/client"
//
// No `eval`, no `new Function`: the output is a plain module the `soupext` scheme can serve.

const REACT = [
  "Children", "Component", "Fragment", "Profiler", "PureComponent", "StrictMode", "Suspense", "cloneElement", "createContext", "createElement",
  "createRef", "forwardRef", "isValidElement", "lazy", "memo", "startTransition", "useCallback", "useContext", "useDebugValue", "useDeferredValue",
  "useEffect", "useId", "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo", "useReducer", "useRef", "useState",
  "useSyncExternalStore", "useTransition", "version",
];

const SOUP = [
  "Plugin", "Notice", "Modal", "SettingTab", "Setting", "RequestError", "normalizePath", "debounce", "apiVersion", "Platform",
];

const MODULES = {
  soup: { global: "soup", names: SOUP },
  react: { global: "react", names: REACT },
  "react/jsx-runtime": { global: "jsxRuntime", names: ["Fragment", "jsx", "jsxs"] },
  "react-dom": { global: "reactDom", names: ["createPortal", "flushSync", "version"] },
  "react-dom/client": { global: "reactDom", names: ["createRoot", "hydrateRoot"] },
};

const PREFIX = "\0soup-external:";

export function soupExternals() {
  return {
    name: "soup-externals",
    enforce: "pre",
    resolveId(id) {
      return id in MODULES ? PREFIX + id : null;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const { global, names } = MODULES[id.slice(PREFIX.length)];
      return [
        `const m = globalThis.__soup && globalThis.__soup.${global};`,
        `if (!m) throw new Error("SOUP did not provide ${id.slice(PREFIX.length)} (globalThis.__soup.${global}): was this extension built for SOUP?");`,
        `export default m;`,
        ...names.map((n) => `export const ${n} = m.${n};`),
      ].join("\n");
    },
  };
}
