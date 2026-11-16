/**
 * GitHub-inspired Light/Dark palettes for Mermaid `base` theme diagrams.
 * VS Code theme variables supply background/foreground/border at runtime;
 * these constants cover categorical, note, git-graph, gantt, and pie roles.
 */

export interface MermaidPalette {
  primaryColor: string;
  primaryTextColor: string;
  primaryBorderColor: string;
  secondaryColor: string;
  secondaryTextColor: string;
  secondaryBorderColor: string;
  tertiaryColor: string;
  tertiaryTextColor: string;
  tertiaryBorderColor: string;
  lineColor: string;
  arrowheadColor: string;
  textColor: string;
  mainBkg: string;
  nodeBorder: string;
  clusterBkg: string;
  clusterBorder: string;
  titleColor: string;
  edgeLabelBackground: string;
  noteBkgColor: string;
  noteTextColor: string;
  noteBorderColor: string;
  actorBkg: string;
  actorBorder: string;
  actorTextColor: string;
  actorLineColor: string;
  signalColor: string;
  signalTextColor: string;
  labelBoxBkgColor: string;
  labelBoxBorderColor: string;
  labelTextColor: string;
  loopTextColor: string;
  activationBkgColor: string;
  activationBorderColor: string;
  sequenceNumberColor: string;
  git0: string;
  git1: string;
  git2: string;
  git3: string;
  git4: string;
  taskBkgColor: string;
  taskTextColor: string;
  taskTextOutsideColor: string;
  activeTaskBkgColor: string;
  doneTaskBkgColor: string;
  critBkgColor: string;
  critBorderColor: string;
  sectionBkgColor: string;
  altSectionBkgColor: string;
  gridColor: string;
  todayLineColor: string;
  cScale0: string;
  cScale1: string;
  cScale2: string;
  cScale3: string;
  cScale4: string;
  cScale5: string;
  cScale6: string;
  cScale7: string;
  cScale8: string;
  cScale9: string;
  pieSectionTextColor: string;
  pieTitleTextColor: string;
  pieOuterStrokeColor: string;
  pie1: string; pie2: string; pie3: string; pie4: string;
  pie5: string; pie6: string; pie7: string; pie8: string;
  pie9: string; pie10: string; pie11: string; pie12: string;
  requirementBackground: string;
  requirementBorderColor: string;
  requirementTextColor: string;
  relationColor: string;
  relationLabelBackground: string;
  relationLabelColor: string;
  classText: string;
  stateBkg: string;
  stateBorder: string;
  stateLabelColor: string;
  transitionColor: string;
  transitionLabelColor: string;
  altBackground: string;
  compositeBackground: string;
  compositeTitleBackground: string;
  innerEndBackground: string;
  specialStateColor: string;
  labelBackgroundColor: string;
}

export const MERMAID_LIGHT_PALETTE: MermaidPalette = {
  primaryColor: '#ddf4ff',
  primaryTextColor: '#1f2328',
  primaryBorderColor: '#0969da',
  secondaryColor: '#f6f8fa',
  secondaryTextColor: '#1f2328',
  secondaryBorderColor: '#d1d9e0',
  tertiaryColor: '#fff8c5',
  tertiaryTextColor: '#1f2328',
  tertiaryBorderColor: '#bf8700',
  lineColor: '#59636e',
  arrowheadColor: '#59636e',
  textColor: '#1f2328',
  mainBkg: '#ffffff',
  nodeBorder: '#d1d9e0',
  clusterBkg: '#f6f8fa',
  clusterBorder: '#d1d9e0',
  titleColor: '#1f2328',
  edgeLabelBackground: '#ffffff',
  noteBkgColor: '#fff8c5',
  noteTextColor: '#1f2328',
  noteBorderColor: '#bf8700',
  actorBkg: '#f6f8fa',
  actorBorder: '#8c959f',
  actorTextColor: '#1f2328',
  actorLineColor: '#d1d9e0',
  signalColor: '#59636e',
  signalTextColor: '#1f2328',
  labelBoxBkgColor: '#ffffff',
  labelBoxBorderColor: '#d1d9e0',
  labelTextColor: '#1f2328',
  loopTextColor: '#1f2328',
  activationBkgColor: '#ddf4ff',
  activationBorderColor: '#0969da',
  sequenceNumberColor: '#1f2328',
  git0: '#0969da',
  git1: '#1a7f37',
  git2: '#8250df',
  git3: '#bc4c00',
  git4: '#cf222e',
  taskBkgColor: '#0969da',
  taskTextColor: '#ffffff',
  taskTextOutsideColor: '#1f2328',
  activeTaskBkgColor: '#0550ae',
  doneTaskBkgColor: '#1a7f37',
  critBkgColor: '#cf222e',
  critBorderColor: '#a40e26',
  sectionBkgColor: '#f6f8fa',
  altSectionBkgColor: '#eef1f4',
  gridColor: '#d1d9e0',
  todayLineColor: '#cf222e',
  cScale0: '#0969da',
  cScale1: '#1a7f37',
  cScale2: '#8250df',
  cScale3: '#bc4c00',
  cScale4: '#cf222e',
  cScale5: '#0550ae',
  cScale6: '#1f883d',
  cScale7: '#a40e26',
  cScale8: '#9a6700',
  cScale9: '#6e7781',
  pieSectionTextColor: '#1f2328',
  pieTitleTextColor: '#1f2328',
  pieOuterStrokeColor: '#d1d9e0',
  pie1: '#0969da', pie2: '#1a7f37', pie3: '#8250df', pie4: '#bc4c00',
  pie5: '#cf222e', pie6: '#0550ae', pie7: '#1f883d', pie8: '#bf3989',
  pie9: '#9a6700', pie10: '#6e7781', pie11: '#218bff', pie12: '#6f42c1',
  requirementBackground: '#f6f8fa',
  requirementBorderColor: '#8c959f',
  requirementTextColor: '#1f2328',
  relationColor: '#59636e',
  relationLabelBackground: '#ffffff',
  relationLabelColor: '#1f2328',
  classText: '#1f2328',
  stateBkg: '#f6f8fa',
  stateBorder: '#8c959f',
  stateLabelColor: '#1f2328',
  transitionColor: '#59636e',
  transitionLabelColor: '#1f2328',
  altBackground: '#f6f8fa',
  compositeBackground: '#f6f8fa',
  compositeTitleBackground: '#f6f8fa',
  innerEndBackground: '#ffffff',
  specialStateColor: '#bf8700',
  labelBackgroundColor: '#ffffff',
};

export const MERMAID_DARK_PALETTE: MermaidPalette = {
  primaryColor: '#1f6feb',
  primaryTextColor: '#f0f6fc',
  primaryBorderColor: '#58a6ff',
  secondaryColor: '#161b22',
  secondaryTextColor: '#f0f6fc',
  secondaryBorderColor: '#30363d',
  tertiaryColor: '#272115',
  tertiaryTextColor: '#f0f6fc',
  tertiaryBorderColor: '#d29922',
  lineColor: '#8b949e',
  arrowheadColor: '#8b949e',
  textColor: '#f0f6fc',
  mainBkg: '#161b22',
  nodeBorder: '#8b949e',
  clusterBkg: '#161b22',
  clusterBorder: '#30363d',
  titleColor: '#f0f6fc',
  edgeLabelBackground: '#0d1117',
  noteBkgColor: '#272115',
  noteTextColor: '#f0f6fc',
  noteBorderColor: '#d29922',
  actorBkg: '#161b22',
  actorBorder: '#8b949e',
  actorTextColor: '#f0f6fc',
  actorLineColor: '#8b949e',
  signalColor: '#c9d1d9',
  signalTextColor: '#f0f6fc',
  labelBoxBkgColor: '#161b22',
  labelBoxBorderColor: '#8b949e',
  labelTextColor: '#f0f6fc',
  loopTextColor: '#f0f6fc',
  activationBkgColor: '#21262d',
  activationBorderColor: '#8b949e',
  sequenceNumberColor: '#f0f6fc',
  git0: '#58a6ff',
  git1: '#3fb950',
  git2: '#bc8cff',
  git3: '#d29922',
  git4: '#f85149',
  taskBkgColor: '#1f6feb',
  taskTextColor: '#ffffff',
  taskTextOutsideColor: '#f0f6fc',
  activeTaskBkgColor: '#388bfd',
  doneTaskBkgColor: '#238636',
  critBkgColor: '#da3633',
  critBorderColor: '#f85149',
  sectionBkgColor: '#161b22',
  altSectionBkgColor: '#21262d',
  gridColor: '#30363d',
  todayLineColor: '#f85149',
  cScale0: '#58a6ff',
  cScale1: '#3fb950',
  cScale2: '#bc8cff',
  cScale3: '#d29922',
  cScale4: '#f85149',
  cScale5: '#388bfd',
  cScale6: '#56d364',
  cScale7: '#f85149',
  cScale8: '#e3b341',
  cScale9: '#8b949e',
  pieSectionTextColor: '#f0f6fc',
  pieTitleTextColor: '#f0f6fc',
  pieOuterStrokeColor: '#30363d',
  pie1: '#58a6ff', pie2: '#3fb950', pie3: '#bc8cff', pie4: '#d29922',
  pie5: '#f85149', pie6: '#388bfd', pie7: '#56d364', pie8: '#db61a2',
  pie9: '#e3b341', pie10: '#8b949e', pie11: '#79c0ff', pie12: '#a371f7',
  requirementBackground: '#161b22',
  requirementBorderColor: '#8b949e',
  requirementTextColor: '#f0f6fc',
  relationColor: '#8b949e',
  relationLabelBackground: '#0d1117',
  relationLabelColor: '#f0f6fc',
  classText: '#f0f6fc',
  stateBkg: '#161b22',
  stateBorder: '#8b949e',
  stateLabelColor: '#f0f6fc',
  transitionColor: '#8b949e',
  transitionLabelColor: '#f0f6fc',
  altBackground: '#161b22',
  compositeBackground: '#161b22',
  compositeTitleBackground: '#161b22',
  innerEndBackground: '#0d1117',
  specialStateColor: '#d29922',
  labelBackgroundColor: '#0d1117',
};

export type MermaidScheme = 'light' | 'dark';

/**
 * Mindmap node fills stay saturated in both schemes, so labels must be
 * white in Light as well as Dark. Scoped to .mindmap-node so other diagram
 * types keep their theme text color.
 */
export const MERMAID_MINDMAP_THEME_CSS = `
.mindmap-node .nodeLabel,
.mindmap-node text,
.mindmap-node foreignObject div,
.mindmap-node foreignObject span {
  color: #ffffff;
  fill: #ffffff;
}
`;

export function mermaidPalette(scheme: MermaidScheme): MermaidPalette {
  return scheme === 'dark' ? MERMAID_DARK_PALETTE : MERMAID_LIGHT_PALETTE;
}
