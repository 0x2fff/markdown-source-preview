/**
 * Compile-time build flag. `true` only in diagnostics/lab builds
 * (MD_LAB=true npm run build); `false` in production builds.
 * Diagnostic code guarded by this flag is eliminated from the
 * production bundle by esbuild dead-code elimination.
 */
declare const __MARKDOWN_SOURCE_PREVIEW_LAB__: boolean;
