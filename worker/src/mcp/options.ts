import {
  LinkExtractionOptionsSchema,
  MarkdownConverterOptionsSchema,
  MetadataOptionsSchema,
  TreeOptionsSchema,
} from '@deepcrawl/types/schemas';
import { z } from 'zod/v4';
import { truncate } from './format';

/**
 * Option shapes shared by the read and links tools. They reuse the API's own
 * schemas, so names and defaults match the HTTP API and the dashboard toggles.
 */

/** The "Markdown Options" panel. */
export const markdownOptions = MarkdownConverterOptionsSchema.unwrap()
  .unwrap()
  .pick({
    preferNativeParser: true,
    keepDataImages: true,
    useInlineLinks: true,
    useLinkReferenceDefinitions: true,
    bulletMarker: true,
    codeBlockStyle: true,
    maxConsecutiveNewlines: true,
  })
  .describe('Markdown conversion settings. Omit to use the defaults.');

/** Per-field switches behind "Extract Metadata -> Configure". */
export const metadataOptions = MetadataOptionsSchema.describe(
  'Which metadata fields to extract. Only used when metadata is true.',
);

/** Content toggles shared by both tools ("Content Format Options"). */
export const contentFlags = {
  metadata: z
    .boolean()
    .optional()
    .describe('Extract page metadata (title, description, Open Graph...).'),
  metadataOptions: metadataOptions.optional(),
  cleanedHtml: z
    .boolean()
    .optional()
    .describe('Include the cleaned HTML of the page. Default false.'),
  robots: z
    .boolean()
    .optional()
    .describe('Fetch and include robots.txt. Default false.'),
  sitemapXML: z
    .boolean()
    .optional()
    .describe('Fetch and include sitemap.xml (beta). Default false.'),
};

/** Tree and link-extraction settings for deepcrawl_extract_links. */
export const treeOptions = TreeOptionsSchema.describe(
  'Site tree settings. Only used when tree is true.',
);
export const linkExtractionOptions = LinkExtractionOptionsSchema.describe(
  'Which links to extract (external, media, query params, exclusions).',
);

/**
 * Truncates each large string field (markdown, HTML, robots.txt, sitemap) so a
 * big page cannot blow up the response while the JSON stays valid.
 */
export function capStrings<T extends Record<string, unknown>>(
  data: T,
  limit: number,
  hint: string,
): T {
  const cap = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return truncate(value, limit, hint);
    }
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'metaFiles' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, cap(v)]),
      );
    } else {
      out[key] = cap(value);
    }
  }
  return out as T;
}
