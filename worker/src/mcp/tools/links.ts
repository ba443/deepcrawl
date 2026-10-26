import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { READ_ONLY_OPEN_WORLD, structuredResult, toolError } from '../format';
import { contentFlags, linkExtractionOptions, treeOptions } from '../options';
import type { DeepcrawlClient } from '../types';
import { urlSchema } from './read';

export function registerLinksTools(server: McpServer, client: DeepcrawlClient) {
  server.registerTool(
    'deepcrawl_extract_links',
    {
      title: 'Extract Links from URL',
      description: `Extract the links found on a web page, optionally as a site map tree.

Use this to explore a site, find sub-pages, or collect URLs to read next. To read a page's content, use deepcrawl_read_url instead.

Args:
  - url (string): Page to extract links from. A full URL or a bare domain.
  - tree (boolean, optional): Also build a site map tree of the page's links. Default false; the tree can be large.

  - treeOptions (object, optional): Site tree settings (folders first, link order, extracted links per node, subdomain as root, platform URL). Used with tree=true.
  - linkExtractionOptions (object, optional): includeExternal, includeMedia, excludePatterns, removeQueryParams.
  - metadata, metadataOptions, cleanedHtml, robots, sitemapXML (optional): Extra page data to include.

Returns (JSON): { success, targetUrl, timestamp, requestId, cached, metadata, tree? }. "tree" is present only when tree=true.

Errors: an unreachable or blocked URL returns an error; check the URL is public and retry. Results may be served from cache.`,
      inputSchema: {
        url: urlSchema,
        tree: z
          .boolean()
          .default(false)
          .describe(
            'Build a site map tree of the extracted links. Larger response.',
          ),
        treeOptions: treeOptions.optional(),
        linkExtractionOptions: linkExtractionOptions.optional(),
        ...contentFlags,
      },
      outputSchema: {
        success: z.boolean(),
        targetUrl: z.string().describe('Final URL after normalization.'),
        timestamp: z.string(),
        requestId: z.string().describe('Activity log id for this request.'),
        cached: z.boolean().optional(),
      },
      annotations: READ_ONLY_OPEN_WORLD,
    },
    async ({ url, tree, ...options }) => {
      try {
        const { treeOptions: treeSettings, ...rest } = options;
        const result = await client.links.extractLinks({
          url,
          tree,
          ...treeSettings,
          ...rest,
        });
        return structuredResult(result as Record<string, unknown>);
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
