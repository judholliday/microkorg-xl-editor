// Home or travel? At home the pages are served by serve.py on this Mac (localhost), which saves
// files in data/ and runs the AI. Anywhere else (e.g. GitHub Pages) there's no server: files are
// kept in the browser, the XL editor and AI features are hidden. Add ?static to a localhost
// address to try the travel version at home.
export const STATIC = new URLSearchParams(location.search).has('static')
  || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
