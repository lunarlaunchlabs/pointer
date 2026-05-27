export function pathFromMonacoUri(uri: string): string {
  return decodeURIComponent(uri)
    .replace(/^file:\/\//, "")
    .replace(/^\/([A-Za-z]):/, "$1:");
}
