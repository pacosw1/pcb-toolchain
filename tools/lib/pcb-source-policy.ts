// Names excluded from an isolated candidate snapshot. Keep build admission and
// snapshot enumeration on the same policy so an admitted script is present.
export const SNAPSHOT_IGNORED = new Set(['.git', '.gate', '.claude', '.bench', '__pycache__', 'node_modules', 'fab', 'render', 'renders', 'reports', 'target']);
export const SNAPSHOT_NOT_SOURCE = new Set(['.pyc', '.step', '.stp', '.wrl', '.mp4', '.gif']);
