// The stylesheet is imported as text: Vite/Vitest via `?raw`, esbuild via widget/build.mjs (loader '.css': 'text').
declare module '*.css?raw' {
  const css: string;
  export default css;
}
