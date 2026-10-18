/** Resolve published datasets independently of application-owned assets. */
export function resolveDatasetURL(
  path: string,
  applicationBase: string,
  serviceBase?: string,
): string {
  if (!serviceBase?.trim()) return new URL(path, applicationBase).href;
  const base = new URL(serviceBase, applicationBase);
  base.pathname = base.pathname.replace(/\/?$/, "/");
  return new URL(path.replace(/^\/+/, ""), base).href;
}
