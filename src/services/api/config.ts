/** Container builds use an authenticated same-origin proxy; standalone builds use the upstream API. */
export const SERVER_API = __SERVER_API__
export const API_ORIGIN = SERVER_API ? '/api' : __API_ORIGIN__
/** Cloudflare 免费版部署：单附件 ≤ 2MB，导入按小批次上传 */
export const EDGE_API = __EDGE_API__
