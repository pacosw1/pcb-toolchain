// Test helper: seals a fixture board so the seal check passes.
import { reseal } from './cad-seal.ts';

export const sealFixtureBoard = (root: string, board: string): void => reseal(root, board, { tool: 'fixture', run_id: null }, 'fixture');
