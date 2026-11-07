export const RELEASE_APPROVAL_SCHEMA: string;
export interface ReleaseApproval { schema: string; board: string; by: string; reason: string; candidate_sha256: string; report: string; report_sha256: string; image: string; image_sha256: string }
export interface ReleaseApprovalStatus { board: string; state: 'missing' | 'invalid' | 'stale' | 'approved'; path: string; problems: string[]; stale: string[]; approval: ReleaseApproval | null }
export function releaseApprovalPath(root: string, board: string): string;
export function releaseApprovalStatus(root: string, board: string, candidate: string): ReleaseApprovalStatus;
export function g5Decision(root: string, board: string, candidate: string, findings: unknown[]): { g5_release_approved: boolean; g5_approval: { state: string; problems: string[]; stale: string[] } };
export function approveRelease(root: string, board: string, candidate: string, options?: { by?: string; reason?: string; report?: string; image?: string }): ReleaseApprovalStatus;
