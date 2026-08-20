// The main app's currently active photo (its preview data: URL), shared with
// the gradient editor so its live preview shows what you're actually working
// on instead of always defaulting to the duck. A tiny standalone module
// rather than an editor.ts import from main.ts, since main.ts imports
// editor.ts already - importing back would be circular.

let currentUrl: string | null = null;

export function setPreviewSubject(url: string | null) {
  currentUrl = url;
}

export function getPreviewSubject(): string | null {
  return currentUrl;
}
