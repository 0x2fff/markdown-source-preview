export const MERMAID_SECURITY_LEVEL = 'strict';

export function mermaidSvgCacheKey(
  version: string,
  securityLevel: string,
  themeKey: string,
  sourceHash: string,
): string {
  return `${version}::${securityLevel}::${themeKey}::${sourceHash}`;
}
