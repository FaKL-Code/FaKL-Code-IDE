import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const esquema = z.object({
  titulo: z.string(),
  descricao: z.string(),
  ordem: z.number(),
});

// Mesmos arquivos nos dois idiomas: docs/ em português, docs-en/ em inglês.
const docs = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/docs' }),
  schema: esquema,
});
const docsEn = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/docs-en' }),
  schema: esquema,
});

export const collections = { docs, docsEn };
