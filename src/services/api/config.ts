/** Container builds use an authenticated same-origin proxy; standalone builds use the upstream API. */
export const SERVER_API = __SERVER_API__
export const API_ORIGIN = SERVER_API ? '/api' : __API_ORIGIN__
