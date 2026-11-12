import { JuejinClient } from './client.js';
import type { Draft, DraftInput } from './types.js';
import { CliError } from '../../shared/errors.js';
import { ImageUploader } from './imagex.js';
import { inferredTitle, localImagePath, readArticle, rewriteImages, scanImages, omitRepeatedTitle, type MarkdownDocument } from '../../content/markdown.js';
import { preflightImages } from './assets.js';

export interface DraftOptions {
  title?: string; brief?: string; category?: string; tags?: string[]; cover?: string;
}

export interface DraftPlan {
  input: DraftInput;
  directory: string;
  localImages: string[];
  localCover?: string;
}

export class DraftService {
  constructor(private readonly client: JuejinClient, private readonly uploader: ImageUploader) {}

  async prepare(file: string, options: DraftOptions, existing?: Draft): Promise<DraftPlan> {
    return this.prepareDocument(await readArticle(file), options, existing);
  }

  async prepareDocument(document: MarkdownDocument, options: DraftOptions, existing?: Draft): Promise<DraftPlan> {
    const title = options.title ?? document.metadata.title ?? existing?.title ?? inferredTitle(document.content);
    const brief = options.brief ?? document.metadata.brief ?? existing?.brief_content;
    if (!title?.trim()) throw new CliError('INPUT', '请提供 --title、frontmatter.title 或一级标题。');
    if (!brief || brief.length < 50 || brief.length > 100) throw new CliError('INPUT', '请提供 50–100 字摘要（--brief 或 frontmatter.brief）。');
    const category = options.category ?? document.metadata.category ?? existing?.category_id;
    if (!category) throw new CliError('INPUT', '请提供 --category 或 frontmatter.category。');
    const categories = await this.client.categories();
    const matched = categories.find(entry => [entry.category_id, entry.category_name, entry.category_url].includes(category));
    if (!matched) throw new CliError('INPUT', `找不到分类「${category}」，请运行 juejin category list。`);
    const names = options.tags ?? document.metadata.tags ?? existing?.tag_ids;
    if (!names?.length) throw new CliError('INPUT', '至少需要一个标签（--tags 或 frontmatter.tags）。');
    const tagIds: string[] = [];
    for (const name of [...new Set(names)]) {
      if (/^\d+$/.test(name)) { tagIds.push(name); continue; }
      const tags = await this.client.findTags(name, true);
      const tag = tags.find(tag => tag.tag_name.toLowerCase() === name.toLowerCase());
      if (!tag) throw new CliError('INPUT', `未找到精确标签「${name}」，请运行 juejin tag search。`);
      tagIds.push(tag.tag_id);
    }
    const cover = options.cover ?? document.metadata.cover ?? existing?.cover_image ?? '';
    const images = scanImages(document.content, document.directory);
    const localCover = cover ? localImagePath(cover, document.directory) : undefined;
    await preflightImages(images, localCover);
    return {
      input: { title, brief_content: brief, category_id: matched.category_id, tag_ids: [...new Set(tagIds)], cover_image: cover, mark_content: omitRepeatedTitle(document.content, title) },
      directory: document.directory,
      localImages: [...new Set(images.map(image => image.path))], localCover,
    };
  }

  async uploadAssets(plan: DraftPlan): Promise<DraftInput> {
    const images = scanImages(plan.input.mark_content, plan.directory);
    const rewritten = await rewriteImages(plan.input.mark_content, images, path => this.uploader.upload(path));
    let cover = plan.input.cover_image;
    if (plan.localCover) cover = rewritten.uploads.get(plan.localCover) ?? await this.uploader.upload(plan.localCover);
    return { ...plan.input, mark_content: rewritten.content, cover_image: cover };
  }
}
