export const RELEASE_ORDER_SCHEMA: string;
export interface ReleaseOrder { schema: string; board: string; by: string; candidate_sha256: string; approval_sha256: string; what: string; quantity: number; reference: string }
export function releaseOrdersPath(root: string, board: string): string;
export function releaseOrders(root: string, board: string): ReleaseOrder[];
export function recordOrder(root: string, board: string, candidate: string, options?: { by?: string; what?: string; quantity?: number; reference?: string }): ReleaseOrder;
