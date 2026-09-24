import { createHash } from 'node:crypto';
import { memoryFingerprint } from '../memory.js';

export const LIMITS = Object.freeze({
  uploadBytes: 8 * 1024 * 1024, expandedBytes: 16 * 1024 * 1024,
  entryBytes: 1024 * 1024, files: 200, uploadFiles: 100, items: 10000,
  ratio: 100, previewMs: 10 * 60 * 1000,
});
export type MigrationSource = 'openclaw' | 'hermes' | 'josi' | 'unknown';
export type Classification = 'imported unchanged' | 'transformed' | 'duplicate' | 'sensitive/refused' | 'unsupported' | 'ignored';
export type Category = 'personality' | 'preferences' | 'behaviour' | 'memory' | 'conversation' | 'automation' | 'workspace';
export interface Provenance {
  source: MigrationSource;
  format: string;
  path: string;
  locator: string;
  sha256: string;
}
export interface MigrationItem {
  id: string;
  category: Category;
  classification: Classification;
  reason: string;
  provenance: Provenance;
  content?: string;
  profileKind?: 'soul' | 'user' | 'agents_user';
  values?: Record<string, string | string[]>;
  pinned?: boolean;
  memoryProvenance?: string;
}
export interface MigrationManifest {
  version: 1;
  items: MigrationItem[];
  fileCount: number;
}
export interface MigrationScope { ownerUserId: string; installationId: string }
export interface MigrationFile { path: string; bytes: Buffer }
export interface Selection { id: string; content?: string }
export interface MigrationReceipt {
  batchId: string;
  created: number;
  counts: Record<Classification, number>;
  items: Array<Pick<MigrationItem, 'id' | 'category' | 'classification' | 'reason' | 'provenance'>>;
}
export class MigrationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function memoryKey(content: string): string {
  return memoryFingerprint(content);
}
export function selectable(item: MigrationItem): boolean {
  return item.classification === 'imported unchanged' || item.classification === 'transformed';
}
export function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
