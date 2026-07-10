jest.mock(
  'src/database/schemas',
  () => ({
    ArtifactType: { POST: 'POST', POLL: 'POLL', DOCUMENT: 'DOCUMENT' },
  }),
  { virtual: true },
);

import { ZodError } from 'zod';
import { ArtifactType } from 'src/database/schemas';
import { parseArtifactContent } from './artifact-content.schema';

describe('parseArtifactContent', () => {
  describe('POST arm', () => {
    it('should accept the commentary when it is exactly 3000 characters', () => {
      const commentary = 'a'.repeat(3000);
      expect(parseArtifactContent(ArtifactType.POST, { commentary })).toEqual({
        commentary,
      });
    });

    it('should accept the commentary when an emoji lands exactly on the 3000 boundary', () => {
      // 🎉 costs 2 LinkedIn characters, so 2998 + 🎉 = exactly 3000
      const commentary = 'a'.repeat(2998) + '🎉';
      expect(parseArtifactContent(ArtifactType.POST, { commentary })).toEqual({
        commentary,
      });
    });

    it('should reject the commentary when it reaches 3001 characters', () => {
      const commentary = 'a'.repeat(3001);
      expect(() =>
        parseArtifactContent(ArtifactType.POST, { commentary }),
      ).toThrow(ZodError);
    });

    it('should reject when an emoji pushes the count to 3001', () => {
      // 2999 BMP chars + a 2-unit emoji = 3001 LinkedIn characters
      const commentary = 'a'.repeat(2999) + '🎉';
      expect(() =>
        parseArtifactContent(ArtifactType.POST, { commentary }),
      ).toThrow(ZodError);
    });

    it('should count by UTF-16 code units, not code points, when the commentary is emoji-only', () => {
      // 1500 astral emoji = 1500 code points but 3000 LinkedIn characters
      expect(() =>
        parseArtifactContent(ArtifactType.POST, {
          commentary: '🎉'.repeat(1500),
        }),
      ).not.toThrow();
      // one more emoji tips it to 3002
      expect(() =>
        parseArtifactContent(ArtifactType.POST, {
          commentary: '🎉'.repeat(1501),
        }),
      ).toThrow(ZodError);
    });

    it('should reject the commentary when it is empty', () => {
      expect(() =>
        parseArtifactContent(ArtifactType.POST, { commentary: '' }),
      ).toThrow(ZodError);
    });

    it('should reject the content when commentary is missing or not a string', () => {
      expect(() => parseArtifactContent(ArtifactType.POST, {})).toThrow(
        ZodError,
      );
      expect(() =>
        parseArtifactContent(ArtifactType.POST, { commentary: 42 }),
      ).toThrow(ZodError);
    });
  });

  describe('unimplemented arms', () => {
    it('should throw when no content schema exists for the artifact type', () => {
      expect(() =>
        parseArtifactContent(ArtifactType.POLL, { commentary: 'x' }),
      ).toThrow('No content schema implemented for artifact type POLL');
      expect(() =>
        parseArtifactContent(ArtifactType.DOCUMENT, { commentary: 'x' }),
      ).toThrow('No content schema implemented for artifact type DOCUMENT');
    });
  });
});
