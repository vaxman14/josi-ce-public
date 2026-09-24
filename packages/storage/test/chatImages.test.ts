import { describe, expect, it, vi } from 'vitest';
import { ChatImageError, isHeic, normalizeChatImage } from '../src/chatImages.js';

const heic = (brand = 'heic') => Buffer.concat([
  Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(12),
]);
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0xff, 0xd9]);

describe('HEIC chat images', () => {
  it('recognizes HEIC and generic HEIF brands by signature', () => {
    expect(isHeic(heic('heic'))).toBe(true);
    expect(isHeic(heic('mif1'))).toBe(true);
    expect(isHeic(Buffer.from('not an image'))).toBe(false);
  });

  it('converts iPhone HEIC uploads into model-compatible JPEG', async () => {
    const convert = vi.fn(async () => jpeg());
    const result = await normalizeChatImage({
      filename: 'IMG_5059.HEIC', declaredContentType: 'image/heic', bytes: heic(), convertHeic: convert,
    });
    expect(convert).toHaveBeenCalledOnce();
    expect(result).toEqual(expect.objectContaining({ filename: 'IMG_5059.jpg', contentType: 'image/jpeg', converted: true }));
    expect(result.bytes).toEqual(jpeg());
  });

  it('rejects HEIF content when extension or declared MIME does not agree', async () => {
    await expect(normalizeChatImage({
      filename: 'photo.bin', declaredContentType: 'application/octet-stream', bytes: heic('heix'), convertHeic: async () => jpeg(),
    })).rejects.toThrow('must agree');
    await expect(normalizeChatImage({
      filename: 'photo.heic', declaredContentType: 'image/png', bytes: heic(), convertHeic: async () => jpeg(),
    })).rejects.toThrow('must agree');
  });

  it('rejects a disguised file instead of trusting extension or MIME type', async () => {
    await expect(normalizeChatImage({
      filename: 'fake.heic', declaredContentType: 'image/heic', bytes: Buffer.from('plain text'),
    })).rejects.toThrow(ChatImageError);
  });

  it('rejects invalid converter output', async () => {
    await expect(normalizeChatImage({
      filename: 'photo.heif', declaredContentType: 'image/heif', bytes: heic(), convertHeic: async () => Buffer.from('not jpeg'),
    })).rejects.toThrow('safely convert');
  });

  it('leaves non-HEIC files unchanged', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await normalizeChatImage({ filename: 'photo.png', declaredContentType: 'image/png', bytes: png });
    expect(result).toEqual({ filename: 'photo.png', contentType: 'image/png', bytes: png, converted: false });
  });
});
